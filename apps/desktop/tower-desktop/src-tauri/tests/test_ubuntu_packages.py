"""Unprivileged tests: no network, package installation, sudo, or host changes."""
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, PropertyMock, patch

spec = importlib.util.spec_from_file_location('ubuntu_packages', Path(__file__).parents[1] / 'src/ubuntu_packages.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.identifier = '7cfdaf4a-8a0a-4b9a-8ab1-e3c2efb87568'

    def review(self):
        plan = {'createdAt': int(time.time()), 'packages': [
            {'name': 'curl:amd64', 'fromVersion': '1', 'toVersion': '2'}], 'failedServices': []}
        result = {'plan': plan, 'digest': helper.digest(plan)}
        helper.write_json(self.directory / 'preview.json', result)
        return result

    def test_review_expiration_and_digest_are_enforced(self):
        result = self.review()
        with patch.object(helper.time, 'time', return_value=result['plan']['createdAt'] + 901):
            with self.assertRaisesRegex(RuntimeError, 'expired'):
                helper.validate_plan(result, result['digest'])
        result['plan']['packages'].clear()
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            helper.validate_plan(result, result['digest'])

    def test_kernel_boot_and_firmware_packages_are_excluded(self):
        for name in ['linux-image-generic', 'linux-image-6.8.0-1-generic:amd64', 'linux-headers-generic',
                     'linux-firmware', 'grub-efi-amd64', 'grub2-common', 'ubuntu-kernel-accessories',
                     'shim-signed', 'intel-microcode', 'initramfs-tools']:
            self.assertTrue(helper.excluded(name), name)
        self.assertFalse(helper.excluded('curl:amd64'))

    def test_plan_conflicts_are_distinguished_from_broken_installed_packages(self):
        cache = MagicMock(broken_count=0, dpkg_journal_dirty=False)
        cache.get_changes.return_value = []
        cache.__iter__.return_value = [SimpleNamespace(fullname='dependent:amd64', is_inst_broken=True, is_now_broken=False)]
        with patch.dict('sys.modules', {'apt_pkg': SimpleNamespace()}), patch.object(helper, 'command', return_value=''), \
                patch.object(type(cache), 'broken_count', PropertyMock(side_effect=[0, 1]), create=True):
            with self.assertRaisesRegex(RuntimeError, 'deferred or held packages: dependent:amd64'):
                helper.changes(cache)
        cache.broken_count = 1
        cache.upgrade.reset_mock()
        with patch.dict('sys.modules', {'apt_pkg': SimpleNamespace()}):
            with self.assertRaisesRegex(RuntimeError, 'Installed packages have broken dependencies'):
                helper.changes(cache)
        cache.upgrade.assert_not_called()

    def test_boot_family_is_kept_together(self):
        packages = [self.package(name) for name in ['grub-common', 'grub-pc-bin', 'grub2-common', 'ubuntu-kernel-accessories']]
        cache = MagicMock(broken_count=0, dpkg_journal_dirty=False)
        cache.get_changes.side_effect = [packages, []]
        with patch.object(helper, 'command', return_value=''), patch.dict('sys.modules', {'apt_pkg': SimpleNamespace()}):
            self.assertEqual(helper.changes(cache), [])
        for package in packages:
            package.mark_keep.assert_called_once()

    def test_command_logs_output_before_process_finishes(self):
        # Child waits for acknowledgement emitted by the parent's live log sink.
        # A buffered implementation times out instead of completing successfully.
        acknowledgement = self.directory / 'ack'
        import io
        import contextlib
        class Sink(io.StringIO):
            def write(self, value):
                if 'READY' in value and not value.startswith('$ '):
                    acknowledgement.touch()
                return super().write(value)
        output = Sink()
        code = "import pathlib,time; print('READY', flush=True); p=pathlib.Path(__import__('sys').argv[1]); deadline=time.time()+3\nwhile not p.exists() and time.time()<deadline: time.sleep(.05)\nassert p.exists(), 'output was buffered'\nprint('DONE', flush=True)"
        with contextlib.redirect_stdout(output):
            result = helper.command([sys.executable, '-c', code, str(acknowledgement)])
        self.assertEqual(result, 'READY\nDONE')
        self.assertIn('$ ', output.getvalue())

    def test_launch_is_idempotent_and_does_not_retry_uncertain_dispatch(self):
        review = self.review()
        with patch.object(helper, 'command', side_effect=TimeoutError('lost response')) as execute:
            self.assertEqual(helper.launch(self.directory, self.identifier, review['digest'])['state'], 'unknown')
            self.assertTrue((self.directory / 'result.json').exists())
            execute.assert_called_once()
            args = execute.call_args.args[0]
            self.assertIn('--property=StandardOutput=append:' + str(self.directory / 'operation.log'), args)
            self.assertIn('--property=StandardError=append:' + str(self.directory / 'operation.log'), args)
        with patch.object(helper, 'command', return_value='active') as execute:
            self.assertEqual(helper.launch(self.directory, self.identifier, review['digest'])['state'], 'running')
            self.assertEqual(execute.call_args.args[0][0], '/usr/bin/systemctl')

    def test_interrupted_service_never_implies_success(self):
        helper.write_json(self.directory / 'result.json', {'state': 'running'})
        with patch.object(helper, 'command', return_value='inactive'):
            self.assertEqual(helper.status(self.directory, self.identifier)['state'], 'unknown')
        helper.write_json(self.directory / 'result.json', {'state': 'successful'})
        with patch.object(helper, 'command') as execute:
            self.assertEqual(helper.status(self.directory, self.identifier)['state'], 'successful')
            execute.assert_not_called()

    def test_missing_launch_is_retired_so_a_delayed_dispatch_cannot_install(self):
        self.assertEqual(helper.status(self.directory, self.identifier)['state'], 'failed')
        with patch.object(helper, 'command') as execute:
            self.assertEqual(helper.launch(self.directory, self.identifier, 'unused')['state'], 'failed')
            execute.assert_not_called()

    def package(self, name='curl', installed=True, upgrade=True):
        return SimpleNamespace(name=name, fullname=name + ':amd64',
                               installed=SimpleNamespace(version='1') if installed else None,
                               candidate=SimpleNamespace(version='2', origins=[SimpleNamespace(trusted=True)]),
                               marked_upgrade=upgrade, marked_delete=False, mark_keep=MagicMock())

    def test_solver_rejects_new_packages_removals_and_untrusted_candidates(self):
        for package in [self.package(installed=False), self.package(upgrade=False), self.package()]:
            if package.installed and package.marked_upgrade:
                package.candidate.origins[0].trusted = False
            cache = MagicMock(broken_count=0, dpkg_journal_dirty=False)
            cache.get_changes.return_value = [package]
            with patch.object(helper, 'command', return_value=''), patch.dict('sys.modules', {'apt_pkg': SimpleNamespace(version_compare=lambda a, b: 1)}):
                with self.assertRaises(RuntimeError):
                    helper.changes(cache)

    def test_held_packages_are_kept_and_remaining_changes_are_checked(self):
        held = self.package('curl')
        cache = MagicMock(broken_count=0, dpkg_journal_dirty=False)
        cache.get_changes.side_effect = [[held], []]
        with patch.object(helper, 'command', return_value='curl'), patch.dict('sys.modules', {'apt_pkg': SimpleNamespace()}):
            self.assertEqual(helper.changes(cache), [])
        held.mark_keep.assert_called_once()
        cache.upgrade.assert_called_once_with(dist_upgrade=False)

    def test_apply_revalidates_under_lock_and_stale_plan_never_commits(self):
        review = self.review()
        cache = MagicMock()
        lock = MagicMock()
        lock.__enter__.side_effect = lambda: None
        with patch.dict('sys.modules', {'apt': SimpleNamespace(Cache=lambda: cache), 'apt_pkg': SimpleNamespace(SystemLock=lambda: lock)}), \
                patch.object(helper, 'ROOT', self.directory), patch.object(helper, 'preflight'), \
                patch.object(helper, 'changes', return_value=[]) as changes:
            helper.worker(self.directory, review['digest'])
        cache.commit.assert_not_called()
        lock.__enter__.assert_called_once()
        changes.assert_called_once_with(cache)
        self.assertEqual(json.loads((self.directory / 'result.json').read_text())['state'], 'failed')

    def test_success_requires_commit_versions_and_post_checks(self):
        review = self.review()
        cache = MagicMock()
        cache.commit.return_value = True
        cache.__getitem__.return_value.installed.version = '2'
        config = MagicMock()
        with patch.dict('sys.modules', {'apt': SimpleNamespace(Cache=lambda: cache), 'apt_pkg': SimpleNamespace(SystemLock=MagicMock, config=config)}), \
                patch.object(helper, 'ROOT', self.directory), patch.object(helper, 'preflight'), \
                patch.object(helper, 'changes', return_value=review['plan']['packages']), \
                patch.object(helper, 'space_for'), patch.object(helper, 'command', return_value=''), \
                patch.object(helper, 'failed_services', return_value=[]):
            helper.worker(self.directory, review['digest'])
        cache.commit.assert_called_once_with(allow_unauthenticated=False)
        self.assertEqual(json.loads((self.directory / 'result.json').read_text())['state'], 'successful')

    def test_repository_failure_does_not_produce_an_applicable_preview(self):
        with patch.dict('sys.modules', {'apt': SimpleNamespace(), 'apt_pkg': SimpleNamespace()}), \
                patch.object(helper, 'preflight', return_value='Ubuntu'), \
                patch.object(helper, 'command', side_effect=RuntimeError('repository unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'repository'):
                helper.preview(self.directory)
        self.assertFalse((self.directory / 'preview.json').exists())

    @unittest.skipUnless(importlib.util.find_spec('apt_pkg'), 'local Python APT bindings are optional for tests')
    def test_real_apt_nested_locks_remain_held_until_outer_scope_ends(self):
        # A separate process isolates APT's global configuration. Every lock is
        # under our temporary directory; the real package database is untouched.
        code = '''
import apt_pkg, pathlib, sys
root = pathlib.Path(sys.argv[1])
(root / 'status').write_text('')
apt_pkg.init_config()
apt_pkg.config.set('Dir::State::status', str(root / 'status'))
apt_pkg.config.set('Debug::NoLocking', 'false')
apt_pkg.init_system()
with apt_pkg.SystemLock():
    assert apt_pkg.pkgsystem_is_locked()
    with apt_pkg.SystemLock():
        assert apt_pkg.pkgsystem_is_locked()
    assert apt_pkg.pkgsystem_is_locked()
assert not apt_pkg.pkgsystem_is_locked()
assert (root / 'lock-frontend').exists()
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, str(self.directory)],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
