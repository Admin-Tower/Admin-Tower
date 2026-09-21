"""Unprivileged reboot tests. Shutdown is always mocked; no host changes."""
import contextlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ubuntu_reboot', Path(__file__).parents[1] / 'src/ubuntu_reboot.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
ORIGINAL_LOCKS = helper.maintenance_locks
BOOT = '11111111-1111-4111-8111-111111111111'
NEW_BOOT = '22222222-2222-4222-8222-222222222222'


class RebootTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.boot = self.directory / 'boot-id'
        self.boot.write_text(BOOT)
        self.plan = {'bootId': BOOT, 'failedServices': []}
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(helper, 'BOOT_ID', self.boot))
        self.stack.enter_context(patch.object(helper, 'snapshot', return_value=self.plan))
        self.stack.enter_context(patch.object(helper, 'maintenance_locks', contextlib.nullcontext))
        self.stack.enter_context(patch.object(helper, 'ssh_startup', return_value='ssh.service'))

    def test_dispatch_is_durable_before_shutdown_and_never_repeated(self):
        def shutdown(args):
            self.assertEqual(json.loads((self.directory / 'result.json').read_text())['state'], 'dispatching')
            self.assertEqual(args[:3], ['/usr/sbin/shutdown', '-r', 'now'])
            return ''
        with patch.object(helper, 'command', side_effect=shutdown) as command:
            helper.dispatch(self.directory, BOOT, int(time.time()))
            with self.assertRaisesRegex(RuntimeError, 'already submitted'):
                helper.dispatch(self.directory, BOOT, int(time.time()))
            command.assert_called_once()

    def test_missing_dispatch_is_retired_before_late_request(self):
        with patch.object(helper, 'command') as command:
            result = helper.status(self.directory, BOOT)
            self.assertEqual(result['state'], 'failed')
            with self.assertRaisesRegex(RuntimeError, 'retired'):
                helper.dispatch(self.directory, BOOT, int(time.time()))
            command.assert_not_called()

    def test_stale_review_or_changed_boot_never_requests_shutdown(self):
        for changed in [False, True]:
            with self.subTest(changed=changed):
                (self.directory / 'result.json').unlink(missing_ok=True)
                self.boot.write_text(NEW_BOOT if changed else BOOT)
                with patch.object(helper, 'command') as command:
                    with self.assertRaises(RuntimeError):
                        helper.dispatch(self.directory, BOOT, int(time.time()) if changed else 1)
                    command.assert_not_called()
                self.assertEqual(json.loads((self.directory / 'result.json').read_text())['state'], 'failed')

    def test_package_maintenance_blocks_reboot(self):
        with patch.object(helper, 'maintenance_locks', side_effect=RuntimeError('Package maintenance is running')), patch.object(helper, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'maintenance'):
                helper.dispatch(self.directory, BOOT, int(time.time()))
            command.assert_not_called()

    def test_lost_shutdown_response_is_unknown_until_a_new_ready_boot(self):
        with patch.object(helper, 'command', side_effect=TimeoutError('response lost')):
            with self.assertRaises(TimeoutError):
                helper.dispatch(self.directory, BOOT, int(time.time()))
        self.assertEqual(helper.status(self.directory, BOOT)['state'], 'unknown')
        self.plan['bootId'] = NEW_BOOT
        with patch.object(helper, 'command', return_value='starting'):
            self.assertEqual(helper.status(self.directory, BOOT)['state'], 'unknown')
        with patch.object(helper, 'command', return_value='running') as command:
            self.assertEqual(helper.status(self.directory, BOOT)['state'], 'successful')
            command.assert_called_once_with(['/usr/bin/systemctl', 'is-system-running'], accepted=(0, 1))

    def test_real_dpkg_lock_contention_prevents_dispatch(self):
        import builtins
        frontend = self.directory / 'frontend-lock'
        frontend.touch()
        holder = subprocess.Popen([sys.executable, '-c',
            "import fcntl,sys; f=open(sys.argv[1], 'r+'); fcntl.lockf(f, fcntl.LOCK_EX); print('locked', flush=True); sys.stdin.read()",
            str(frontend)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), 'locked')
            real_open = builtins.open
            def mapped_open(name, *args, **kwargs):
                return real_open(frontend if str(name) == '/var/lib/dpkg/lock-frontend' else name, *args, **kwargs)
            with patch.object(helper, 'maintenance_locks', ORIGINAL_LOCKS), \
                    patch.object(helper, 'PACKAGE_ROOT', self.directory / 'packages'), \
                    patch.object(helper, 'private_directory', side_effect=lambda path: path.mkdir(exist_ok=True)), \
                    patch('builtins.open', side_effect=mapped_open), patch.object(helper, 'command') as command:
                with self.assertRaisesRegex(RuntimeError, 'Package maintenance is running'):
                    helper.dispatch(self.directory, BOOT, int(time.time()))
                command.assert_not_called()
        finally:
            holder.communicate('', timeout=5)

    def test_ssh_startup_is_rechecked_before_dispatch(self):
        with patch.object(helper, 'ssh_startup', side_effect=RuntimeError('SSH startup changed')), patch.object(helper, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'SSH startup changed'):
                helper.dispatch(self.directory, BOOT, int(time.time()))
            command.assert_not_called()
        self.assertEqual(json.loads((self.directory / 'result.json').read_text())['state'], 'failed')

    def test_real_entrypoint_refuses_unprivileged_dispatch(self):
        import os
        if os.geteuid() == 0:
            self.skipTest('Never exercise the dispatch entrypoint as root')
        for action in ['preview', 'reboot', 'status']:
            result = subprocess.run([sys.executable, '-B', helper.__file__, action, NEW_BOOT, BOOT, str(int(time.time()))], capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Root or passwordless sudo is required', result.stdout)


class SshStartupTests(unittest.TestCase):
    def unit(self, enabled='disabled', active='inactive', substate='dead', loaded='loaded', reload='no'):
        return {'LoadState': loaded, 'UnitFileState': enabled, 'ActiveState': active,
                'SubState': substate, 'NeedDaemonReload': reload}

    def check(self, service, socket):
        def execute(args, **kwargs):
            if args == ['/usr/sbin/sshd', '-t']:
                return ''
            self.assertEqual(args[:2], ['/usr/bin/systemctl', 'show'])
            unit = service if args[2] == 'ssh.service' else socket
            return '\n'.join(f'{key}={value}' for key, value in unit.items())
        with patch.object(helper, 'command', side_effect=execute):
            return helper.ssh_startup()

    def test_persistent_service_startup(self):
        self.assertEqual(self.check(self.unit('enabled', 'active', 'running'), self.unit(loaded='not-found')), 'ssh.service')

    def test_socket_activation_allows_disabled_service(self):
        self.assertEqual(self.check(self.unit(), self.unit('enabled', 'active', 'listening')), 'ssh.socket')

    def test_disabled_runtime_only_inactive_and_masked_paths_are_rejected(self):
        for state in ['disabled', 'enabled-runtime', 'static', 'indirect', 'masked']:
            with self.subTest(state=state), self.assertRaisesRegex(RuntimeError, 'Reboot blocked'):
                self.check(self.unit(state, 'active', 'running'), self.unit(state, 'active', 'listening'))
        with self.assertRaisesRegex(RuntimeError, 'Reboot blocked'):
            self.check(self.unit('enabled'), self.unit('enabled'))
        with self.assertRaisesRegex(RuntimeError, 'Reboot blocked'):
            self.check(self.unit(loaded='masked'), self.unit('enabled', 'active', 'listening'))

    def test_pending_service_config_reload_and_invalid_sshd_config_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'daemon reload'):
            self.check(self.unit('enabled', 'active', 'running', reload='yes'), self.unit())
        with patch.object(helper, 'command', side_effect=RuntimeError('sshd configuration invalid')) as command:
            with self.assertRaisesRegex(RuntimeError, 'configuration invalid'):
                helper.ssh_startup()
            command.assert_called_once_with(['/usr/sbin/sshd', '-t'])


if __name__ == '__main__':
    unittest.main()
