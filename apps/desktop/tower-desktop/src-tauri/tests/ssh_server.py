"""Disposable loopback SSH server for integration tests; never uses account keys."""
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

    def check_channel_exec_request(self, channel, command):
        (directory / "last-command").write_bytes(command)
        self.executed.set()
        return True


def handle(client):
    transport = paramiko.Transport(client)
    try:
        transport.add_server_key(server_key)
        server = Server()
        transport.start_server(server=server)
        channel = transport.accept(5)
        if channel is not None and server.executed.wait(5):
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
