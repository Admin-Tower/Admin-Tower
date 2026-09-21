"""Fixed Ubuntu APT workflow, transported by Ansible; no caller-supplied commands.

Preview changes package indexes and writes a root-owned plan. Apply starts a
systemd service, so loss of the controller cannot kill a dpkg transaction.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path('/var/lib/admin-tower/package-updates')
TTL = 900
TERMINAL = {'successful', 'failed'}


def command(args):
    print('$ ' + shlex.join(args), flush=True)
    # A temporary file avoids pipe deadlocks and permits a strict command timeout.
    with tempfile.TemporaryFile() as output:
        with subprocess.Popen(args, stdout=output, stderr=subprocess.STDOUT) as process:
            started, offset, captured = time.monotonic(), 0, bytearray()
            while True:
                finished = process.poll() is not None
                if not finished and time.monotonic() - started > 120:
                    process.kill()
                    raise RuntimeError('Command timed out: ' + args[0])
                chunk = os.pread(output.fileno(), 65536, offset)
                if chunk:
                    offset += len(chunk)
                    captured.extend(chunk)
                    del captured[:-1024 * 1024]
                    print(chunk.decode('utf-8', errors='replace'), end='', flush=True)
                elif finished:
                    break
                else:
                    time.sleep(0.1)
            result = captured.decode('utf-8', errors='replace').strip()
            if process.returncode:
                raise RuntimeError(result[-8000:] or 'Command failed: ' + args[0])
            return result


def private_directory(path):
    if not path.exists():
        private_directory(path.parent)
        path.mkdir(mode=0o700)
    info = path.lstat()
    if path.is_symlink() or not path.is_dir() or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Unsafe root-owned job directory: ' + str(path))


def write_json(path, value):
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


def failed_services():
    return sorted(line.split()[0] for line in command([
        '/usr/bin/systemctl', '--failed', '--plain', '--no-legend', '--no-pager'
    ]).splitlines() if line.strip())


def preflight():
    release = dict(line.strip().split('=', 1) for line in
                   Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if release.get('ID', '').strip('"') != 'ubuntu':
        raise RuntimeError('Only Ubuntu is supported by this task.')
    if not Path('/run/systemd/system').is_dir():
        raise RuntimeError('A running systemd system is required.')
    for path in ('/', '/var', '/boot'):
        if shutil.disk_usage(path).free < (200 if path == '/boot' else 1024) * 1024**2:
            raise RuntimeError('Insufficient free space on ' + path)
    audit = command(['/usr/bin/dpkg', '--audit'])
    if audit:
        raise RuntimeError('Repair the package database before updating: ' + audit)
    return release.get('PRETTY_NAME', 'Ubuntu').strip('"')


def excluded(name):
    # Kernel, boot loader and firmware maintenance is a separate task.
    name = name.split(':')[0]
    return name.startswith(('linux-', 'ubuntu-kernel-', 'grub-', 'grub2-', 'shim', 'systemd-boot', 'fwupd')) or name.endswith('-dkms') or name in {
        'dkms',
        'intel-microcode', 'amd64-microcode', 'flash-kernel', 'initramfs-tools',
        'initramfs-tools-core', 'initramfs-tools-bin', 'dracut', 'dracut-core',
    }


def changes(cache):
    import apt_pkg
    if cache.dpkg_journal_dirty:
        raise RuntimeError('The package database contains an unfinished transaction. No packages changed.')
    if cache.broken_count:
        raise RuntimeError('Installed packages have broken dependencies. No packages changed.')
    held = set(command(['/usr/bin/apt-mark', 'showhold']).splitlines())
    cache.upgrade(dist_upgrade=False)
    for package in cache.get_changes():
        if excluded(package.name) or package.name in held or package.fullname in held:
            package.mark_keep()
    if cache.broken_count:
        broken = ', '.join(sorted(package.fullname for package in cache if package.is_inst_broken))
        raise RuntimeError('The update plan conflicts with deferred or held packages: ' + broken + '. No packages changed.')
    result = []
    for package in cache.get_changes():
        if (not package.installed or not package.candidate or not package.marked_upgrade
                or package.marked_delete or excluded(package.name)
                or package.name in held or package.fullname in held
                or apt_pkg.version_compare(package.candidate.version, package.installed.version) <= 0):
            raise RuntimeError('The plan would install, remove, downgrade or change an excluded package.')
        if not any(origin.trusted for origin in package.candidate.origins):
            raise RuntimeError('Unauthenticated package candidate: ' + package.name)
        result.append({'name': package.fullname, 'fromVersion': package.installed.version,
                       'toVersion': package.candidate.version})
    return sorted(result, key=lambda package: package['name'])


def digest(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def space_for(cache):
    required = max(cache.required_space, 0) + cache.required_download + 1024**3
    for path in ('/', '/var'):
        if shutil.disk_usage(path).free < required:
            raise RuntimeError('Insufficient space for downloads and installation on ' + path)


def preview(directory):
    import apt
    import apt_pkg
    os_name = preflight()
    # Errors from any repository abort the preview rather than using stale indexes.
    command(['/usr/bin/apt-get', '-o', 'APT::Update::Error-Mode=any', 'update'])
    with apt_pkg.SystemLock():
        cache = apt.Cache()
        packages = changes(cache)
        space_for(cache)
        plan = {'packages': packages, 'os': os_name, 'createdAt': int(time.time()),
                'failedServices': failed_services(),
                'deferred': sorted(p.fullname for p in cache if p.is_upgradable and not p.marked_upgrade)}
    result = {'state': 'ready', 'plan': plan, 'digest': digest(plan),
              'rebootRequired': Path('/var/run/reboot-required').exists(),
              'message': 'Preview ready. Package indexes refreshed; no packages installed.'}
    write_json(directory / 'preview.json', result)
    return result


def validate_plan(review, expected_digest):
    if review['digest'] != expected_digest or digest(review['plan']) != expected_digest:
        raise RuntimeError('Preview changed. Create and review a new preview.')
    age = time.time() - review['plan']['createdAt']
    if not 0 <= age <= TTL:
        raise RuntimeError('Preview expired. Create and review a new preview.')


def unit_name(identifier):
    return 'admin-tower-apt-' + identifier + '.service'


def recorded_status(directory, identifier):
    path = directory / 'result.json'
    if not path.exists():
        # The caller holds launch.lock. Retire the reviewed run before reporting
        # failure, so a delayed original launch cannot install after this reply.
        result = {'state': 'failed', 'message': 'No installation was launched. This preview has been retired; preview again.'}
        write_json(path, result)
        return result
    result = json.loads(path.read_text())
    if result['state'] not in TERMINAL:
        # A dead service or reboot without a terminal record is never success.
        active = command(['/usr/bin/systemctl', 'show', unit_name(identifier), '--property=ActiveState', '--value'])
        if active not in ('active', 'activating', 'reloading'):
            result = {**result, 'state': 'unknown', 'message': 'The update has no terminal result. Inspect the host before further maintenance.'}
    return result


def status(directory, identifier):
    with (directory / 'launch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return recorded_status(directory, identifier)


def launch(directory, identifier, expected_digest):
    # Per-run launch lock gives at-most-once dispatch, even across controllers.
    with (directory / 'launch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (directory / 'result.json').exists():
            return recorded_status(directory, identifier)
        review = json.loads((directory / 'preview.json').read_text())
        try:
            validate_plan(review, expected_digest)
        except Exception as error:
            result = {'state': 'failed', 'message': str(error)}
            write_json(directory / 'result.json', result)
            return result
        worker = directory / 'worker.py'
        worker.write_text(Path(__file__).read_text())
        worker.chmod(0o600)
        write_json(directory / 'result.json', {'state': 'running', 'message': 'Starting package updates.'})
        try:
            command(['/usr/bin/systemd-run', '--quiet', '--unit=' + unit_name(identifier),
                     '--property=Type=exec', '--property=TimeoutStopSec=infinity',
                     '--property=StandardOutput=append:' + str(directory / 'operation.log'),
                     '--property=StandardError=append:' + str(directory / 'operation.log'),
                     '/usr/bin/python3', str(worker), 'worker', identifier, expected_digest])
        except Exception:
            # Dispatch may have reached systemd even if the response was lost.
            return {'state': 'unknown', 'message': 'Launch could not be confirmed. Refresh status; do not rerun APT manually.'}
        return {'state': 'running', 'message': 'Updating packages on the server.'}


def worker(directory, expected_digest):
    import apt
    import apt_pkg
    try:
        with (ROOT / 'update.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            review = json.loads((directory / 'preview.json').read_text())
            validate_plan(review, expected_digest)
            preflight()
            # Keep the APT frontend lock from revalidation through commit. Nested
            # python-apt SystemLock instances are reference counted by libapt.
            with apt_pkg.SystemLock():
                cache = apt.Cache()
                if changes(cache) != review['plan']['packages']:
                    raise RuntimeError('Package state changed since preview. No packages installed; preview again.')
                space_for(cache)
                apt_pkg.config.clear('Dpkg::Options')
                apt_pkg.config.set('Dpkg::Options::', '--force-confdef')
                apt_pkg.config.set('Dpkg::Options::', '--force-confold')
                os.environ.update(DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l', UCF_FORCE_CONFFOLD='1')
                print('APT: installing approved versions: ' + ', '.join(p['name'] + '=' + p['toVersion'] for p in review['plan']['packages']), flush=True)
                if review['plan']['packages'] and not cache.commit(allow_unauthenticated=False):
                    raise RuntimeError('APT did not complete successfully.')
                cache.open()
                for package in review['plan']['packages']:
                    installed = cache[package['name']].installed
                    if not installed or installed.version != package['toVersion']:
                        raise RuntimeError('Installed versions do not match the approved plan.')
            audit = command(['/usr/bin/dpkg', '--audit'])
            new_failures = sorted(set(failed_services()) - set(review['plan']['failedServices']))
            if audit or new_failures:
                raise RuntimeError('Post-update checks failed: ' + audit + ' ' + ', '.join(new_failures))
            write_json(directory / 'result.json', {
                'state': 'successful', 'rebootRequired': Path('/var/run/reboot-required').exists(),
                'message': 'Approved versions installed; package database and failed-service checks passed. Application health is not checked.'})
    except Exception as error:
        write_json(directory / 'result.json', {
            'state': 'failed', 'rebootRequired': Path('/var/run/reboot-required').exists(),
            'message': str(error)[:8000] + ' Inspect the host before retrying; packages may have changed.'})


def main():
    os.umask(0o077)
    os.environ.update(PATH='/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL='C.UTF-8')
    if os.geteuid() != 0:
        raise RuntimeError('Root or passwordless sudo is required.')
    action, identifier = sys.argv[1:3]
    if str(uuid.UUID(identifier)) != identifier or action not in {'preview', 'apply', 'status', 'worker'}:
        raise RuntimeError('Invalid package-update request.')
    private_directory(ROOT)
    directory = ROOT / identifier
    if action == 'preview':
        directory.mkdir(mode=0o700)  # Never overwrite an existing approved plan.
    private_directory(directory)
    # APT progress goes to a root-owned log, leaving stdout as a JSON protocol.
    with (directory / 'operation.log').open('a', buffering=1) as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        try:
            if action == 'preview':
                result = preview(directory)
            elif action == 'apply':
                result = launch(directory, identifier, sys.argv[3])
            elif action == 'worker':
                worker(directory, sys.argv[3])
                print(json.loads((directory / 'result.json').read_text())['message'], flush=True)
                return
            else:
                result = status(directory, identifier)
            print(result.get('message', ''), flush=True)
        except Exception as error:
            print(str(error), flush=True)
            raise
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        action = sys.argv[1] if len(sys.argv) > 1 else ''
        # Transport/status errors cannot establish that installation failed.
        print(json.dumps({'state': 'unknown' if action in {'apply', 'status'} else 'failed',
                          'message': str(error)[:8000]}))
        sys.exit(1)
