"""Hermetic exact-generation replacement; never runs the privileged entrypoint."""
import errno
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

path = Path(__file__).with_name('2026-11-03-timer-repair.py')
module = None
if path.exists():
    spec = importlib.util.spec_from_file_location('timer_repair', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


class ReplacementTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(module, 'exact-generation repair guard is not implemented')
        self.names = ['fcd-support-operation@.service', 'fcd-support-backup.timer',
                      'fcd-support-maintenance.timer', 'fcd-support-health.timer']
        self.old = {name: ('synthetic old ' + name + '\n').encode() for name in self.names}
        self.new = dict(self.old)
        self.new[self.names[0]] = b'synthetic new service\n'

    def populate(self, root):
        for name, data in self.old.items():
            (root / name).write_bytes(data)
            os.chmod(root / name, 0o644)

    def hashes(self, contents):
        return {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}

    @unittest.skipUnless(os.name == 'posix', 'Unix descriptor semantics required')
    def test_exact_replacement_preserves_unchanged_unit_inodes_and_unrelated_file(self):
        with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-repair-') as directory:
            root = Path(directory); self.populate(root)
            unrelated = root / 'synthetic-unrelated'; unrelated.write_bytes(b'synthetic preserved')
            inodes = {name: (root / name).stat().st_ino for name in self.names[1:]}
            module.replace_generation(root, self.new, self.hashes(self.old), self.hashes(self.new))
            for name in self.names:
                self.assertEqual((root / name).read_bytes(), self.new[name])
            self.assertEqual(inodes, {name: (root / name).stat().st_ino for name in self.names[1:]})
            self.assertEqual(unrelated.read_bytes(), b'synthetic preserved')
            self.assertEqual(len(list(root.iterdir())), 5)

    @unittest.skipUnless(os.name == 'posix', 'Unix descriptor semantics required')
    def test_changed_or_symlink_old_generation_refuses_before_replacement(self):
        for symlink in [False, True]:
            with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-repair-') as directory:
                root = Path(directory); self.populate(root)
                target = root / self.names[0]
                if symlink:
                    target.rename(root / 'synthetic-original'); target.symlink_to(root / 'synthetic-original')
                else:
                    target.write_bytes(b'synthetic changed')
                with self.assertRaises(RuntimeError):
                    module.replace_generation(root, self.new, self.hashes(self.old), self.hashes(self.new))
                self.assertEqual((root / self.names[1]).read_bytes(), self.old[self.names[1]])

    @unittest.skipUnless(os.name == 'posix', 'Unix descriptor semantics required')
    def test_publish_failure_keeps_old_generation_and_reaps_owned_temporary_file(self):
        with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-repair-') as directory:
            root = Path(directory); self.populate(root)
            with mock.patch.object(module.os, 'replace', side_effect=OSError(errno.ENOSPC, 'synthetic full')):
                with self.assertRaises(OSError):
                    module.replace_generation(root, self.new, self.hashes(self.old), self.hashes(self.new))
            self.assertEqual(set(p.name for p in root.iterdir()), set(self.names))
            for name in self.names:
                self.assertEqual((root / name).read_bytes(), self.old[name])

    def test_changed_new_bytes_or_extra_unit_refuses_before_filesystem_access(self):
        for contents in [{**self.new, self.names[0]: b'synthetic unexpected'},
                         {**self.new, '../synthetic': b'synthetic'}]:
            with self.assertRaises(RuntimeError):
                module.replace_generation(Path('/synthetic/absent'), contents,
                                          self.hashes(self.old), self.hashes(self.new))

    @unittest.skipUnless(os.name == 'posix', 'Unix directory fsync required')
    def test_failed_completion_directory_fsync_removes_only_its_owned_record(self):
        for foreign in [False, True]:
            with tempfile.TemporaryDirectory(prefix='fcd-synthetic-timer-record-') as directory:
                root = Path(directory); target = root / 'timer-repair-completed.json'; count = 0
                original_fsync = os.fsync
                def sync(fd):
                    nonlocal count
                    count += 1
                    if count == 2:
                        if foreign:
                            replacement = root / 'synthetic-replacement'
                            replacement.write_bytes(b'synthetic foreign evidence'); replacement.replace(target)
                        raise OSError(errno.ENOSPC, 'synthetic directory sync failure')
                    return original_fsync(fd)
                with mock.patch.object(module, 'ACTION', root), mock.patch.object(module.os, 'fsync', side_effect=sync):
                    with self.assertRaises(OSError): module.marker(target.name, b'{"synthetic":"success"}', mode=0o644)
                self.assertEqual(target.exists(), foreign)
                if foreign: self.assertEqual(target.read_bytes(), b'synthetic foreign evidence')


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(callable(getattr(module, 'verify_scheduled_services', None)))
        self.assertTrue(callable(getattr(module, 'enable_timers', None)))
        self.trace = []
        self.started = set()
        self.fault = None
        outer = self
        class Manager:
            def RefUnit(self, unit, **kwargs): outer.trace.append(('ref', unit))
            def UnrefUnit(self, unit, **kwargs): outer.trace.append(('unref', unit))
        self.manager = Manager()

    def fake_run(self, args, timeout=30):
        self.trace.append(tuple(args))
        if args[:2] == ['systemctl', 'start'] and '.service' in args[2]:
            if self.fault == 'start': raise RuntimeError('synthetic failed service')
            self.started.add(args[2]); return ''
        if args[:2] == ['systemctl', 'show']:
            if 'ExecMainStartTimestampMonotonic' in args:
                return '1' if self.fault == 'stale' or args[2] not in self.started else '2'
            if 'Result' in args: return 'success'
            if 'ExecMainCode' in args: return '1'
            if 'ExecMainStatus' in args: return '0'
            if 'ActiveState' in args: return 'inactive'
            if 'UnitFileState' in args: return 'disabled'
        if args[:2] == ['systemctl', 'is-enabled']: return 'enabled'
        if args[:2] == ['systemctl', 'is-active']: return 'active'
        return ''

    def test_each_actual_service_is_pinned_through_start_and_result_then_unpinned(self):
        module.verify_scheduled_services(self.fake_run, self.manager, lambda: True)
        for job in ['backup', 'maintenance', 'health']:
            unit = 'fcd-support-operation@' + job + '.service'
            start = self.trace.index(('systemctl', 'start', unit))
            self.assertLess(self.trace.index(('ref', unit)), start)
            self.assertGreater(self.trace.index(('unref', unit)), start)
        self.assertFalse(any(item[:2] == ('systemctl', 'enable') for item in self.trace))

    def test_failed_or_stale_service_unpins_and_refuses_before_later_services_or_timers(self):
        for fault in ['start', 'stale']:
            self.trace = []; self.started = set(); self.fault = fault
            with self.subTest(fault=fault), self.assertRaises(RuntimeError):
                module.verify_scheduled_services(self.fake_run, self.manager, lambda: True)
            self.assertIn(('unref', 'fcd-support-operation@backup.service'), self.trace)
            self.assertNotIn(('ref', 'fcd-support-operation@maintenance.service'), self.trace)
            self.assertFalse(any(item[:2] == ('systemctl', 'enable') for item in self.trace))

    def test_pending_job_refuses_after_first_service(self):
        with self.assertRaises(RuntimeError):
            module.verify_scheduled_services(self.fake_run, self.manager, lambda: False)
        self.assertNotIn(('ref', 'fcd-support-operation@maintenance.service'), self.trace)

    def test_completion_failure_stops_and_disables_only_the_three_exact_timers(self):
        def fail(): raise OSError(errno.ENOSPC, 'synthetic completion failure')
        with self.assertRaises(OSError): module.enable_timers(self.fake_run, fail)
        timers = tuple('fcd-support-' + job + '.timer' for job in ['backup', 'maintenance', 'health'])
        self.assertIn(('systemctl', 'stop', *timers), self.trace)
        self.assertIn(('systemctl', 'disable', *timers), self.trace)
        self.assertFalse(any('.service' in item for command in self.trace for item in command))


if __name__ == '__main__':
    unittest.main()
