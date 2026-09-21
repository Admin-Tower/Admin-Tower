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
        self.command = b""
        self.username = ""

    def get_allowed_auths(self, username):
        return "publickey"

    def check_auth_publickey(self, username, key):
        with (directory / "attempts").open("a") as output:
            output.write(key.get_base64() + "\n")
        self.username = username
        if (username == "fixture" or ((directory / "ansible-mode").exists() and username in ("missingpython", "slow"))) and key.get_base64() == authorized:
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
        self.command = command
        if (directory / "ansible-mode").exists():
            with (directory / "commands").open("ab") as output:
                output.write(command + b"\n")
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


def stream_ansible(channel, server):
    # Only the opt-in automation fixture executes code: a fixed Python interpreter
    # receiving Ansible's pipelined module. Never execute the received SSH command.
    command = server.command.decode()
    if "echo FOUND" in command:
        channel.sendall(b"FOUND\n/usr/bin/python3\nENDFOUND\n")
        channel.send_exit_status(0)
    elif server.username == "missingpython":
        channel.send_stderr(b"/usr/bin/python3: not found\n")
        channel.send_exit_status(127)
    elif server.username == "slow":
        time.sleep(8)
        channel.send_exit_status(1)
    elif "/usr/bin/python3" in command:
        payload = bytearray()
        channel.settimeout(10)
        while True:
            data = channel.recv(65536)
            if not data:
                break
            payload.extend(data)
            if len(payload) > 8 * 1024 * 1024:
                raise OSError("Oversized fixture payload")
        result = subprocess.run(
            ["/usr/bin/python3"], input=bytes(payload), capture_output=True,
            cwd=directory, env={"HOME": str(directory), "PATH": "/usr/bin:/bin"}, timeout=10,
        )
        channel.sendall(result.stdout)
        channel.send_stderr(result.stderr)
        channel.send_exit_status(result.returncode)
    else:
        channel.send_stderr(b"Unsupported fixture command\n")
        channel.send_exit_status(1)
    channel.shutdown_write()
    time.sleep(0.1)


def stream_reboot(channel, server):
    # Never execute a received reboot command. Simulate boot IDs and one lost
    # verification connection; only the setup module uses the existing sandbox fixture.
    command = server.command.decode()
    changed = directory / "reboot-submitted"
    if "Reboot requested through Admin-Tower" in command:
        with (directory / "reboot-count").open("a") as output:
            output.write("submitted\n")
        changed.touch()
        channel.sendall(b"Simulated reboot submitted\n")
        channel.send_exit_status(0)
    elif "/proc/sys/kernel/random/boot_id" in command:
        retry = directory / "reboot-retry"
        if changed.exists() and not retry.exists():
            retry.touch()
            channel.close()
            return
        boot = "22222222-2222-4222-8222-222222222222" if changed.exists() else "11111111-1111-4111-8111-111111111111"
        channel.sendall((boot + "\n").encode())
        channel.send_exit_status(0)
    elif "systemctl is-system-running" in command:
        channel.sendall(b"running\n")
        channel.send_exit_status(0)
    else:
        stream_ansible(channel, server)
        return
    channel.shutdown_write()
    time.sleep(0.1)


def handle(client):
    transport = paramiko.Transport(client)
    try:
        transport.add_server_key(server_key)
        server = Server()
        transport.start_server(server=server)
        channel = transport.accept(5)
        if channel is not None and server.executed.wait(5):
            if (directory / "reboot-mode").exists():
                stream_reboot(channel, server)
                return
            if (directory / "ansible-mode").exists():
                stream_ansible(channel, server)
                return
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
