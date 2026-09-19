"""Disposable loopback SSH server for integration tests; never uses account keys."""
import fcntl
import os
import select
import struct
import subprocess
import termios
import time
import tty
import json
import logging
from pathlib import Path
import socket
import sys
import threading

import paramiko

logging.disable(logging.CRITICAL)
directory = Path(sys.argv[1])
authorized = (directory / "client.pub").read_text().split()[1]
server_key = paramiko.RSAKey.generate(2048)


class Server(paramiko.ServerInterface):
    def __init__(self):
        self.executed = threading.Event()
        self.size = (24, 80)
        self.master = None

    def get_allowed_auths(self, username):
        return "publickey"

    def check_auth_publickey(self, username, key):
        with (directory / "attempts").open("a") as output:
            output.write(key.get_base64() + "\n")
        if username == "fixture" and key.get_base64() == authorized:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes):
        self.size = (height, width)
        (directory / "pty.json").write_text(json.dumps({"term": term.decode(), "cols": width, "rows": height}))
        return True

    def check_channel_window_change_request(self, channel, width, height, pixelwidth, pixelheight):
        self.size = (height, width)
        if self.master is not None:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        (directory / "resize.json").write_text(json.dumps({"cols": width, "rows": height}))
        return True

    def check_channel_exec_request(self, channel, command):
        (directory / "last-command").write_bytes(command)
        self.executed.set()
        return True


def stream_htop(channel, server):
    # Explicit opt-in fixture: execute only the fixed local read-only viewer,
    # never any command supplied by the SSH client.
    master, slave = os.openpty()
    server.master = master
    tty.setraw(slave)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", *server.size, 0, 0))
    child = subprocess.Popen(
        ["/usr/bin/htop", "--readonly", "--delay=1"],
        stdin=slave, stdout=slave, stderr=slave,
        env={"TERM": "xterm-256color", "HTOPRC": "/dev/null", "LC_ALL": "C.UTF-8", "PATH": "/usr/bin:/bin"},
        start_new_session=True,
    )
    os.close(slave)
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not channel.closed:
            ready, _, _ = select.select([master, channel], [], [], 0.05)
            if master in ready:
                try:
                    data = os.read(master, 16384)
                except OSError:
                    break
                if not data:
                    break
                channel.sendall(data)
            if channel in ready:
                data = channel.recv(1024)
                if not data:
                    break
                (directory / "terminal-input").write_bytes(data)
                os.write(master, data)
            if child.poll() is not None:
                break
        if child.poll() is not None:
            channel.send_exit_status(child.returncode)
    finally:
        server.master = None
        if child.poll() is None:
            child.kill()
        child.wait()
        os.close(master)


def handle(client):
    transport = paramiko.Transport(client)
    try:
        transport.add_server_key(server_key)
        server = Server()
        transport.start_server(server=server)
        channel = transport.accept(5)
        if channel is not None and server.executed.wait(5):
            if (directory / "htop-mode").exists():
                stream_htop(channel, server)
                return
            snapshot = directory / "snapshot"
            channel.sendall(snapshot.read_bytes() if snapshot.exists() else b"fixture-ok\n")
            channel.send_exit_status(0)
            channel.shutdown_write()
            # Let the client consume its exit status before closing the transport.
            server.executed.clear()
            server.executed.wait(0.1)
    except (EOFError, OSError, paramiko.SSHException):
        pass
    finally:
        transport.close()


listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(8)
port = listener.getsockname()[1]
(directory / "ready.tmp").write_text(json.dumps({
    "port": port,
    "knownHost": f"[127.0.0.1]:{port} {server_key.get_name()} {server_key.get_base64()}\n",
}))
(directory / "ready.tmp").rename(directory / "ready.json")
while True:
    client, _ = listener.accept()
    threading.Thread(target=handle, args=(client,), daemon=True).start()
