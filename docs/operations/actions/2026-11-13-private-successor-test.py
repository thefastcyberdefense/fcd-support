"""Authored, hermetic successor admission controls; no Docker/SSH calls."""
import copy
import importlib.util
import json
import stat
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest import mock

MODULE = Path(__file__).with_name('2026-11-13-private-successor.py')
if MODULE.exists():
    spec = importlib.util.spec_from_file_location('private_successor', MODULE)
    subject = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(subject)
else:
    subject = None


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(subject, 'successor admission implementation missing')

    def job(self):
        return '\n'.join([
            'JOB_VERSION=1', 'JOB_REF=operation_' + 'a' * 32,
            'JOB_PARENT=synthetic-held-project', 'JOB_SERVICE=health',
            'JOB_REVISION=' + 'b' * 40, 'JOB_IMAGE=sha256:' + 'c' * 64,
            'JOB_COMMAND_SHA256=' + 'd' * 64, 'JOB_CONTAINER=' + 'e' * 64,
            'JOB_PHASE=uncertain', ''])

    def test_complete_held_record_is_parsed_without_resolving_it(self):
        record = subject.parse_held_job(self.job().encode(), 'synthetic-held-project')
        self.assertEqual(record['JOB_PHASE'], 'uncertain')
        self.assertEqual(record['JOB_SERVICE'], 'health')

    def test_duplicates_unknown_fields_and_changed_phase_are_refused(self):
        for suffix in ['JOB_PHASE=uncertain\n', 'UNKNOWN=synthetic\n']:
            with self.subTest(suffix=suffix), self.assertRaises(subject.Refusal):
                subject.parse_held_job((self.job() + suffix).encode(), 'synthetic-held-project')
        with self.assertRaises(subject.Refusal):
            subject.parse_held_job(self.job().replace('uncertain', 'completed').encode(), 'synthetic-held-project')

    def test_foreign_parent_role_nul_or_container_shape_is_refused(self):
        for old, new in [('synthetic-held-project', 'synthetic-foreign'), ('JOB_SERVICE=health', 'JOB_SERVICE=backup'), ('JOB_CONTAINER=' + 'e' * 64, 'JOB_CONTAINER=pending'), ('JOB_VERSION=1', 'JOB_VERSION=1\x00')]:
            with self.subTest(old=old), self.assertRaises(subject.Refusal):
                subject.parse_held_job(self.job().replace(old, new).encode(), 'synthetic-held-project')

    def test_fresh_paths_are_canonical_and_disjoint(self):
        subject.require_disjoint('/home/synthetic/new', ['/home/synthetic/old', '/srv/synthetic'])
        for target, mounts in [('/home/synthetic/new/../old', []), ('/home/synthetic//new', []), ('/home/synthetic/new', ['/home/synthetic']), ('/home/synthetic/new', ['/home/synthetic/new/file'])]:
            with self.subTest(target=target), self.assertRaises(subject.Refusal):
                subject.require_disjoint(target, mounts)

    def test_network_selection_avoids_existing_and_host_routes(self):
        block = subject.choose_block(['198.19.0.0/20'], ['0.0.0.0/0', '198.19.16.0/20'])
        self.assertEqual(block, '198.19.32.0/20')
        with self.assertRaises(subject.Refusal):
            subject.choose_block(['198.19.0.0/16'], [])
        with self.assertRaises(subject.Refusal):
            subject.choose_block(['synthetic-invalid-network'], [])

    def test_preservation_excludes_only_known_admin_volatile_state(self):
        before = [{'id': 'a' * 64, 'image': 'synthetic-image', 'mounts': [], 'running': True, 'restarting': False}, {'id': 'b' * 64, 'image': 'synthetic-other', 'mounts': [], 'running': True, 'restarting': False}]
        after = copy.deepcopy(before)
        after[0]['running'] = False
        after[0]['restarting'] = True
        subject.require_preserved(before, after, 'a' * 64)
        for key, value in [('image', 'synthetic-replaced'), ('mounts', [{'Source': '/synthetic/changed'}])]:
            changed = copy.deepcopy(after)
            changed[0][key] = value
            with self.subTest(key=key), self.assertRaises(subject.Refusal):
                subject.require_preserved(before, changed, 'a' * 64)
        after[1]['running'] = False
        with self.assertRaises(subject.Refusal):
            subject.require_preserved(before, after, 'a' * 64)

    def test_added_or_removed_unrelated_actor_is_refused(self):
        before = [{'id': 'a' * 64, 'image': 'synthetic-image'}]
        for after in [[], before + [{'id': 'b' * 64, 'image': 'synthetic-other'}]]:
            with self.subTest(after=after), self.assertRaises(subject.Refusal):
                subject.require_preserved(before, after, None)

    def test_scheduler_binding_is_exact(self):
        revision = 'a' * 40
        command = '{ path=/usr/bin/bash ; argv[]=/usr/bin/bash /synthetic/source/scripts/run-operation.sh health ' + revision + ' /synthetic/config/operations.env ; ignore_errors=no ; }'
        subject.require_scheduler_binding(command, '/synthetic/source', revision, '/synthetic/config/operations.env')
        for text in [command.replace('/synthetic/source', '/synthetic/other'), command.replace(revision, 'b' * 40), command.replace(' health ', ' backup ')]:
            with self.subTest(text=text), self.assertRaises(subject.Refusal):
                subject.require_scheduler_binding(text, '/synthetic/source', revision, '/synthetic/config/operations.env')

    def test_source_pin_and_read_only_cli_fail_closed(self):
        self.assertEqual(subject.inspect_arguments(['--inspect', subject.APPROVED_SOURCE]), subject.APPROVED_SOURCE)
        for args in [[], ['--deploy', subject.APPROVED_SOURCE], ['--inspect', 'a' * 40], ['--inspect', 'synthetic-invalid']]:
            with self.subTest(args=args), self.assertRaises(subject.Refusal):
                subject.inspect_arguments(args)

    def test_partial_admission_result_cannot_report_success(self):
        output = []
        result = subject.main(['--inspect', subject.APPROVED_SOURCE],
                              inspect=lambda _revision: {'read_only_inspection_complete': True},
                              emit=output.append)
        self.assertEqual(result, 1)
        self.assertEqual(output, ['successor_preflight_refused_stage=inspection'])

    def test_double_leading_slash_is_not_a_new_distinct_path(self):
        with self.assertRaises(subject.Refusal):
            subject.require_disjoint('//home/synthetic/new', ['/home/synthetic/old'])

    def test_reader_never_invokes_mutating_tools_even_with_decoy_read_tokens(self):
        for command in [['docker', '--host', subject.ENDPOINT, 'container', 'start', 'synthetic'],
                        ['git', '--no-optional-locks', 'checkout', '--orphan', 'rev-parse'],
                        ['systemctl', 'restart', 'synthetic.service']]:
            with self.subTest(command=command), mock.patch.object(subject.subprocess, 'run') as run:
                run.return_value.returncode = 0
                run.return_value.stdout = ''
                with self.assertRaises(subject.Refusal):
                    subject.Reader().run(command, 'inspection')
                run.assert_not_called()

    def test_reader_timeout_retains_closed_stage_not_exception_body(self):
        with mock.patch.object(subject.subprocess, 'run', side_effect=subject.subprocess.TimeoutExpired(
                ['synthetic-read'], 15, output='SYNTHETIC_TIMEOUT_BODY_MUST_STAY_PRIVATE')):
            with self.assertRaises(subject.Refusal) as outcome:
                subject.Reader().run(['docker', '--host', subject.ENDPOINT, 'ps'], 'containers')
            self.assertEqual(outcome.exception.stage, 'containers')
            self.assertNotIn('SYNTHETIC_TIMEOUT_BODY_MUST_STAY_PRIVATE', str(outcome.exception))

    def test_scheduler_snapshot_covers_all_instances_and_protected_config(self):
        reader = mock.Mock()
        revision = 'a' * 40
        def observe(argv, _stage):
            unit = argv[2]
            if unit == subject.UNITS[0]:
                raise subject.Refusal('scheduler')
            if '--property=FragmentPath' in argv:
                fragment = subject.UNITS[0] if unit.startswith('fcd-support-operation@') else unit
                return 'FragmentPath=/etc/systemd/system/' + fragment + '\nDropInPaths='
            if '--property=ExecStart' in argv:
                service = unit.split('@')[1].split('.')[0]
                return '{ argv[]=/usr/bin/bash ' + str(subject.OLD_ROOT) + '/scripts/run-operation.sh ' + service + ' ' + revision + ' ' + str(subject.HELD_ROOT / 'config/operations.env') + ' ; }'
            return 'ActiveState=active\nUnitFileState=enabled'
        reader.run.side_effect = observe
        with mock.patch.object(subject.Path, 'resolve', lambda self, **_kwargs: self), mock.patch.object(subject, 'checked_file', return_value=(b'SYNTHETIC_CONFIG', ('synthetic-fingerprint',))) as checked:
            first = subject.scheduler_snapshot(reader, revision)
            protected = subject.HELD_ROOT / 'config/operations.env'
            self.assertIn(mock.call(protected, 1000, 0o600, 65536), checked.call_args_list)
            units = {call.args[0][2] for call in reader.run.call_args_list}
            for service in ('backup', 'maintenance', 'health'):
                self.assertIn('fcd-support-operation@' + service + '.service', units)
            with mock.patch.object(subject, 'checked_file', return_value=(b'SYNTHETIC_CHANGED', ('different-fingerprint',))):
                self.assertNotEqual(subject.scheduler_snapshot(reader, revision), first)

    def test_backup_instance_override_and_redirect_are_refused(self):
        reader = mock.Mock()
        revision = 'a' * 40
        def observe(argv, _stage):
            unit = argv[2]
            if '--property=FragmentPath' in argv:
                fragment = subject.UNITS[0] if '@' in unit else unit
                return 'FragmentPath=/etc/systemd/system/' + fragment + '\nDropInPaths=' + ('/synthetic/override.conf' if unit == 'fcd-support-operation@backup.service' else '')
            if '--property=ExecStart' in argv:
                service = unit.split('@')[1].split('.')[0]
                return '{ argv[]=/usr/bin/bash ' + str(subject.OLD_ROOT) + '/scripts/run-operation.sh ' + service + ' ' + revision + ' ' + str(subject.HELD_ROOT / 'config/operations.env') + ' ; }'
            return 'ActiveState=active\nUnitFileState=enabled'
        reader.run.side_effect = observe
        with mock.patch.object(subject.Path, 'resolve', lambda self, **_kwargs: self), mock.patch.object(subject, 'checked_file', return_value=(b'SYNTHETIC', ('synthetic',))):
            with self.assertRaises(subject.Refusal):
                subject.scheduler_snapshot(reader, revision)
        command = '{ argv[]=/usr/bin/bash /synthetic/source/scripts/run-operation.sh backup ' + revision + ' /synthetic/config ; }'
        subject.require_scheduler_binding(command, '/synthetic/source', revision, '/synthetic/config', 'backup')
        with self.assertRaises(subject.Refusal):
            subject.require_scheduler_binding(command.replace(' backup ', ' health '), '/synthetic/source', revision, '/synthetic/config', 'backup')

    def test_network_attachment_drift_is_collected_and_refused(self):
        actor = 'a' * 64
        reader = mock.Mock()
        before = {'id': actor, 'name': '/synthetic', 'networks': {'synthetic-net': {'NetworkID': 'b' * 64, 'EndpointID': 'c' * 64}}}
        reader.docker.side_effect = [actor, json.dumps(before)]
        first = subject.container_snapshot(reader)
        projection = reader.docker.call_args.args[3]
        self.assertIn('.NetworkSettings.Networks', projection)
        after = copy.deepcopy(before)
        after['networks'] = {}
        reader.docker.side_effect = [actor, json.dumps(after)]
        second = subject.container_snapshot(reader)
        with self.assertRaises(subject.Refusal):
            subject.require_preserved(first, second, actor)

    def test_container_health_uses_missing_key_safe_projection(self):
        reader = mock.Mock()
        actor = 'a' * 64
        reader.docker.side_effect = [actor, json.dumps({'id': actor})]
        subject.container_snapshot(reader)
        projection = reader.docker.call_args.args[3]
        self.assertNotIn('.State.Health', projection)
        self.assertIn('index .State "Health"', projection)

    def complete_result(self):
        return {key: True for key in ('read_only_inspection_complete', 'held_journal_preserved',
                'recorded_actor_absent', 'connected_stack_running', 'new_namespace_absent',
                'network_block_available', 'scheduler_source_binding_preserved',
                'private_admin_running', 'private_admin_healthy',
                'disk_capacity_admitted', 'memory_capacity_admitted')}

    def test_resource_refusal_keeps_complete_preservation_evidence_without_admission(self):
        result = self.complete_result()
        result['disk_capacity_admitted'] = False
        result['private_admin_healthy'] = False
        output = []
        code = subject.main(['--inspect', subject.APPROVED_SOURCE], inspect=lambda _revision: result, emit=output.append)
        self.assertEqual(code, 1)
        self.assertIn('successor_held_journal_preserved=true', output)
        self.assertIn('successor_disk_capacity_admitted=false', output)
        self.assertEqual(output[-1], 'successor_preflight_refused_stage=resources')

    def test_full_resource_admission_and_unhealthy_old_admin_are_distinct(self):
        result = self.complete_result()
        result['private_admin_healthy'] = False
        output = []
        self.assertEqual(subject.main(['--inspect', subject.APPROVED_SOURCE], inspect=lambda _revision: result, emit=output.append), 0)
        self.assertEqual(len(output), 11)
        self.assertIn('successor_private_admin_healthy=false', output)

    def test_foreign_labeled_container_cannot_occupy_new_namespace(self):
        project = 'synthetic-fresh-project'
        with self.assertRaises(subject.Refusal):
            subject.require_namespace_absent(project, [{'project': 'synthetic-other', 'name': '/' + project + '-admin-1'}], [], [])
        with self.assertRaises(subject.Refusal):
            subject.require_namespace_absent(project, [{'project': project, 'name': '/synthetic-other'}], [], [])
        subject.require_namespace_absent(project, [{'project': 'synthetic-other', 'name': '/synthetic-other-admin-1'}], [], [])

    def test_existing_volume_or_network_refuses_fresh_namespace(self):
        project = 'synthetic-fresh-project'
        for networks, volumes in [([{'name': project + '_data'}], []), ([], [{'name': project + '_data'}])]:
            with self.subTest(networks=networks, volumes=volumes), self.assertRaises(subject.Refusal):
                subject.require_namespace_absent(project, [], networks, volumes)

    def file_metadata(self, **changes):
        fields = dict(st_mode=stat.S_IFREG | 0o600, st_nlink=1, st_uid=1000, st_gid=1000,
                      st_size=9, st_dev=1, st_ino=17, st_mtime_ns=100)
        fields.update(changes)
        return SimpleNamespace(**fields)

    def test_protected_file_refuses_symlink_wrong_owner_or_hardlink(self):
        for changes, symlink in [({}, True), ({'st_uid': 0}, False), ({'st_nlink': 2}, False), ({'st_mode': stat.S_IFREG | 0o644}, False)]:
            path = mock.Mock()
            path.lstat.return_value = self.file_metadata(**changes)
            path.is_symlink.return_value = symlink
            with self.subTest(changes=changes, symlink=symlink), mock.patch.object(subject.os, 'open') as opened:
                with self.assertRaises(subject.Refusal):
                    subject.checked_file(path, 1000, 0o600)
                opened.assert_not_called()

    def test_protected_file_refuses_open_identity_swap_and_closes_descriptor(self):
        path = mock.Mock()
        path.lstat.return_value = self.file_metadata()
        path.is_symlink.return_value = False
        with mock.patch.object(subject.os, 'O_NOFOLLOW', 0x20000, create=True), mock.patch.object(subject.os, 'open', return_value=7), mock.patch.object(subject.os, 'fstat', return_value=self.file_metadata(st_ino=18)), mock.patch.object(subject.os, 'read') as read, mock.patch.object(subject.os, 'close') as close:
            with self.assertRaises(subject.Refusal):
                subject.checked_file(path, 1000, 0o600)
            read.assert_not_called()
            close.assert_called_once_with(7)

    def test_changed_protected_body_changes_private_fingerprint(self):
        path = mock.Mock()
        path.lstat.return_value = self.file_metadata()
        path.is_symlink.return_value = False
        with mock.patch.object(subject.os, 'O_NOFOLLOW', 0x20000, create=True), mock.patch.object(subject.os, 'open', return_value=7), mock.patch.object(subject.os, 'fstat', return_value=self.file_metadata()), mock.patch.object(subject.os, 'read', side_effect=[b'SYNTHETIC', b'SYNTHETIX']), mock.patch.object(subject.os, 'close'):
            first = subject.checked_file(path, 1000, 0o600)[1]
            second = subject.checked_file(path, 1000, 0o600)[1]
            self.assertNotEqual(first, second)

    def test_remote_error_body_is_never_published(self):
        output = []
        def fail(_revision):
            raise RuntimeError('SYNTHETIC_ERROR_BODY_MUST_STAY_PRIVATE')
        code = subject.main(['--inspect', subject.APPROVED_SOURCE], inspect=fail, emit=output.append)
        self.assertEqual(code, 1)
        self.assertEqual(output, ['successor_preflight_refused_stage=inspection'])


if __name__ == '__main__':
    unittest.main()
