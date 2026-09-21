"""Fixed Ubuntu reboot preflight, at-most-once dispatch guard and recovery probe."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path('/var/lib/admin-tower/reboots')
PACKAGE_ROOT = Path('/var/lib/admin-tower/package-updates')
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')


def command(args, accepted=(0,)):
    print('$ ' + ' '.join(args), flush=True)
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30, check=False)
    if result.stdout:
        print(result.stdout[-32000:], end='', flush=True)
    if result.returncode not in accepted:
        raise RuntimeError(result.stdout[-8000:] or 'Command failed: ' + args[0])
    return result.stdout.strip()


def private_directory(path):
    if not path.exists():
        private_directory(path.parent)
        path.mkdir(mode=0o700)
    info = path.lstat()
    if path.is_symlink() or not path.is_dir() or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Unsafe root-owned job directory: ' + str(path))


def record(path, value):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def ssh_startup():
    # Ubuntu supports both persistent service startup and socket activation.
    # Runtime-only enablement will disappear on reboot and must not pass.
    command(['/usr/sbin/sshd', '-t'])
    units = {}
    for unit in ('ssh.service', 'ssh.socket'):
        output = command(['/usr/bin/systemctl', 'show', unit,
                          '--property=LoadState,UnitFileState,ActiveState,SubState,NeedDaemonReload'], accepted=(0, 1, 4))
        units[unit] = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    service = units['ssh.service']
    socket = units['ssh.socket']
    if service.get('LoadState') != 'loaded' or service.get('NeedDaemonReload') != 'no':
        raise RuntimeError('SSH startup cannot be verified: ssh.service is missing, masked, or needs a daemon reload. Reboot blocked.')
    socket_ready = (socket.get('LoadState') == 'loaded' and socket.get('UnitFileState') == 'enabled'
                    and socket.get('ActiveState') == 'active' and socket.get('SubState') in ('listening', 'running')
                    and socket.get('NeedDaemonReload') == 'no')
    service_ready = (service.get('UnitFileState') == 'enabled' and service.get('ActiveState') == 'active'
                     and service.get('SubState') == 'running')
    if socket_ready:
        startup = 'ssh.socket'
    elif service_ready:
        startup = 'ssh.service'
    else:
        raise RuntimeError('SSH is not confirmed enabled for boot. Configure persistent startup for ssh.service or ssh.socket, then review again. Reboot blocked; SSH configuration was not changed.')
    print('SSH startup verified: ' + startup + ' is persistently enabled and active; sshd configuration is valid.', flush=True)
    return startup


def snapshot():
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if release.get('ID', '').strip('"') != 'ubuntu' or not Path('/run/systemd/system').is_dir():
        raise RuntimeError('Reboot requires Ubuntu with a running systemd system.')
    startup = ssh_startup()
    boot = BOOT_ID.read_text().strip()
    uuid.UUID(boot)
    failed = command(['/usr/bin/systemctl', '--failed', '--plain', '--no-legend', '--no-pager'])
    requested = Path('/var/run/reboot-required.pkgs')
    return {'sshStartup': startup, 'bootId': boot, 'createdAt': int(time.time()), 'os': release.get('PRETTY_NAME', 'Ubuntu').strip('"'),
            'requestedBy': requested.read_text()[:8000].splitlines() if requested.exists() else [],
            'failedServices': sorted(line.split()[0] for line in failed.splitlines() if line.strip())}


@contextlib.contextmanager
def maintenance_locks():
    # Match the package worker's flock and libapt/dpkg's POSIX locks.
    private_directory(PACKAGE_ROOT)
    with contextlib.ExitStack() as stack:
        lock = stack.enter_context((PACKAGE_ROOT / 'update.lock').open('a'))
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for name in ['/var/lib/dpkg/lock-frontend', '/var/lib/dpkg/lock']:
                file = stack.enter_context(open(name, 'r+'))
                fcntl.lockf(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Package maintenance is running. Wait for it to finish before rebooting.') from error
        audit = command(['/usr/bin/dpkg', '--audit'])
        if audit:
            raise RuntimeError('Repair the package database before rebooting: ' + audit)
        yield


def dispatch(directory, expected_boot, created_at):
    path = directory / 'result.json'
    if path.exists():
        raise RuntimeError('This reboot was already submitted or retired. Refresh its status; do not retry it.')
    try:
        if not 0 <= time.time() - created_at <= 900:
            raise RuntimeError('Reboot review expired. Review again.')
        snapshot()  # Revalidate OS and systemd before any side effect.
        with maintenance_locks():
            if BOOT_ID.read_text().strip() != expected_boot:
                raise RuntimeError('The host rebooted since review. Review again.')
            ssh_startup()  # Recheck immediately before committing the reboot request.
            # Durable uncertainty marker BEFORE the shutdown command. Never retry.
            record(path, {'state': 'dispatching'})
            command(['/usr/sbin/shutdown', '-r', 'now', 'Reboot requested through Admin-Tower'])
    except Exception as error:
        if not path.exists():
            record(path, {'state': 'failed', 'message': str(error)})
        raise


def status(directory, expected_boot):
    path = directory / 'result.json'
    # Caller holds launch.lock; retire absent dispatch so a delayed command cannot reboot later.
    if not path.exists():
        record(path, {'state': 'failed', 'message': 'No reboot was submitted. This review has been retired; review again.'})
    plan = snapshot()
    required = Path('/var/run/reboot-required').exists()
    if plan['bootId'] != expected_boot:
        system_state = command(['/usr/bin/systemctl', 'is-system-running'], accepted=(0, 1))
        if system_state in ('running', 'degraded'):
            return {'state': 'successful', 'plan': plan, 'rebootRequired': required,
                    'message': 'New boot verified; SSH and systemd are ready. Application health is not checked.'}
    recorded = json.loads(path.read_text())
    if recorded['state'] == 'failed':
        return recorded
    return {'state': 'unknown', 'message': 'A new ready boot has not been verified. Refresh status; do not submit another reboot.',
            'rebootRequired': required}


def main():
    os.umask(0o077)
    os.environ.update(PATH='/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL='C.UTF-8')
    if os.geteuid() != 0:
        raise RuntimeError('Root or passwordless sudo is required.')
    action, identifier = sys.argv[1:3]
    if action not in {'preview', 'reboot', 'status'} or str(uuid.UUID(identifier)) != identifier:
        raise RuntimeError('Invalid reboot request.')
    if action == 'preview':
        with maintenance_locks():
            plan = snapshot()
        return {'state': 'ready', 'plan': plan, 'rebootRequired': Path('/var/run/reboot-required').exists(),
                'message': 'Review complete. No reboot has been requested.'}
    expected_boot = sys.argv[3]
    if str(uuid.UUID(expected_boot)) != expected_boot:
        raise RuntimeError('Invalid reviewed boot ID.')
    private_directory(ROOT)
    directory = ROOT / identifier
    private_directory(directory)
    with (directory / 'launch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == 'reboot':
            dispatch(directory, expected_boot, int(sys.argv[4]))
            return {'state': 'running', 'message': 'Reboot submitted.'}
        return status(directory, expected_boot)


if __name__ == '__main__':
    try:
        print(json.dumps(main()), flush=True)
    except Exception as error:
        print(json.dumps({'state': 'failed', 'message': str(error)[:8000]}), flush=True)
        sys.exit(1)
