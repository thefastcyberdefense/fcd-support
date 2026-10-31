"""Authored synthetic guard/runner cases; temporary files only, no SSH or Docker."""
import copy
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reboot_recovery', Path(__file__).with_name('2026-10-31-reboot-recovery-67a4a4b.py'))
module = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'fcntl': types.ModuleType('fcntl')}):
    spec.loader.exec_module(module)


def fixture():
    endpoint = {'NetworkID': 'synthetic-bridge-before', 'EndpointID': 'synthetic-endpoint-before', 'IPAddress': '192.0.2.2', 'IPPrefixLen': 24, 'Gateway': '192.0.2.1', 'IPAMConfig': None, 'Aliases': ['synthetic-api'], 'UnknownAttribute': 'synthetic-preserved'}
    member = {'Name': 'synthetic-running', 'EndpointID': 'synthetic-endpoint-before', 'IPv4Address': '192.0.2.2/24', 'UnknownAttribute': 'synthetic-preserved'}
    before = {'files': {'synthetic-state': ['synthetic-preserved']}, 'volumes': [{'name': 'synthetic-volume'}], 'actors': [
        {'id': 'synthetic-running', 'state': 'running', 'started': 'synthetic-before', 'image': 'synthetic-image', 'mounts': [{'synthetic': True}], 'ports': {}, 'networks': {'bridge': endpoint}},
        {'id': 'synthetic-stopped', 'state': 'exited', 'started': 'synthetic-old', 'image': 'synthetic-image', 'mounts': [], 'ports': {}, 'networks': {}}],
        'networks': [{'id': 'synthetic-bridge-before', 'name': 'bridge', 'created': 'synthetic-before', 'driver': 'bridge', 'internal': False, 'ipam': {'synthetic': True}, 'members': {'synthetic-running': member}}, {'id': 'synthetic-private', 'name': 'synthetic-private', 'created': 'synthetic-preserved', 'members': {}}]}
    after = copy.deepcopy(before)
    after['actors'][0]['started'] = 'synthetic-after'
    after['actors'][0]['networks']['bridge'].update(NetworkID='synthetic-bridge-after', EndpointID='synthetic-endpoint-after')
    after['networks'][0].update(id='synthetic-bridge-after', created='synthetic-after')
    after['networks'][0]['members']['synthetic-running']['EndpointID'] = 'synthetic-endpoint-after'
    return before, after


class RebootPreservationTests(unittest.TestCase):
    def test_only_documented_running_actor_and_default_bridge_changes_pass(self):
        before, after = fixture()
        module.reboot_compatible(before, after)

    def test_every_other_field_and_multiplicity_stays_authoritative(self):
        mutations = [
            lambda x: x['files'].update({'synthetic-foreign': []}),
            lambda x: x['volumes'].clear(),
            lambda x: x['actors'][0].update(image='synthetic-substitution'),
            lambda x: x['actors'][0].update(state='exited'),
            lambda x: x['actors'][0].update(ports={'synthetic': True}),
            lambda x: x['actors'][0]['mounts'].clear(),
            lambda x: x['actors'][1].update(started='synthetic-after'),
            lambda x: x['actors'][0].update(UnknownAttribute='synthetic-change'),
            lambda x: x['actors'][0]['networks']['bridge'].update(IPAMConfig={'synthetic': 'changed'}),
            lambda x: x['actors'][0]['networks']['bridge'].update(UnknownAttribute='synthetic-change'),
            lambda x: x['actors'][0]['networks']['bridge'].update(NetworkID='synthetic-foreign'),
            lambda x: x['networks'][1].update(id='synthetic-substitution'),
            lambda x: x['networks'][0]['ipam'].update(synthetic=False),
            lambda x: x['networks'][0]['members'].clear(),
            lambda x: x['networks'][0]['members']['synthetic-running'].update(UnknownAttribute='synthetic-change'),
            lambda x: x['actors'].append(copy.deepcopy(x['actors'][0])),
            lambda x: x['networks'].append(copy.deepcopy(x['networks'][0])),
            lambda x: x['actors'][0].update(started='synthetic-before'),
            lambda x: x['actors'][0]['networks']['bridge'].update(Gateway='203.0.113.1'),
            lambda x: x['actors'][0]['networks']['bridge'].update(IPPrefixLen=8),
            lambda x: x['networks'][0]['members']['synthetic-running'].update(IPv4Address='192.0.2.2/8'),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                before, after = fixture(); mutate(after)
                with self.assertRaises(RuntimeError): module.reboot_compatible(before, after)

    def test_unchanged_private_network_cannot_change_gateway_or_prefix(self):
        for field, value in [('Gateway', '203.0.113.1'), ('IPPrefixLen', 8)]:
            with self.subTest(field=field):
                before, after = fixture()
                for snapshot in [before, after]:
                    endpoint = copy.deepcopy(snapshot['actors'][0]['networks']['bridge'])
                    endpoint['NetworkID'] = 'synthetic-private'
                    snapshot['actors'][0]['networks']['synthetic-private'] = endpoint
                after['actors'][0]['networks']['synthetic-private'][field] = value
                with self.assertRaises(RuntimeError): module.reboot_compatible(before, after)


class PreservedRestartPolicyTests(unittest.TestCase):
    def test_stopped_old_targets_require_restart_disabled_and_policies_are_pinned(self):
        import json
        actors = [{'id': 'synthetic-target-' + str(i), 'state': 'exited'} for i in range(3)]
        projects = ['fcd-support-restore-host-test-p6-b0ba255', 'fcd-support-restore-host-test-p6-8ccb9a0-r2', 'fcd-support-restore-host-test-p6-6faff8b']
        for invalid in [None, 'always', 'unless-stopped']:
            policies = {a['id']: {'Name': 'no', 'MaximumRetryCount': 0} for a in actors}
            if invalid: policies[actors[0]['id']]['Name'] = invalid
            def run(args):
                if args[1] == 'inspect': return '\n'.join(ident + '|' + json.dumps(value) for ident, value in policies.items())
                project = next(value.split('=', 2)[2] for value in args if value.startswith('label=com.docker.compose.project='))
                return actors[projects.index(project)]['id']
            with self.subTest(policy=invalid), patch.object(module, 'run', run):
                if invalid:
                    with self.assertRaises(RuntimeError): module.preserved_policies({'actors': actors})
                else:
                    self.assertEqual(module.preserved_policies({'actors': actors}), policies)


class RecoveryControlFlowTests(unittest.TestCase):
    def exercise(self, fault=None, rollback=False, repeat=False):
        import contextlib
        import tempfile
        with tempfile.TemporaryDirectory(prefix='synthetic-reboot-recovery-') as directory:
            parent = Path(directory); recovery = parent / 'action'; calls = []; state = {'phase': 'restarting'}
            record = {'pins': {'synthetic': 'boot'}, 'bindings': {'synthetic-config': 'same', 'synthetic-secret-metadata': 'same', 'synthetic-restore-record': 'same'}, 'admin': {'synthetic': 'admin-definition'}, 'socket': [1, 2]}
            def actor():
                phase = state['phase']
                return {'Id': 'synthetic-admin', 'State': {'Status': phase, 'Running': phase == 'running', 'Restarting': phase == 'restarting', 'Health': {'Status': 'healthy' if phase == 'running' else 'unhealthy'}}}
            def command(args, name, timeout=2400):
                kind = args[2] if args[0] == 'docker' else {'recover-admin-socket.sh': 'recover', 'verify-runtime.sh': 'verify', 'rollback-runtime.sh': 'rollback'}[Path(args[1]).name]
                calls.append((kind, args))
                if fault == kind: raise RuntimeError('synthetic-command-refused')
                if kind == 'stop': state['phase'] = 'exited'
                if kind == 'start': state['phase'] = 'running'
                if kind == 'recover': (recovery / name).write_bytes(b'synthetic_bad_ack\n' if fault == 'ack' else b'admin_socket_recovered\n')
            def saved():
                if fault == 'boot' and any(k == 'recover' for k, _ in calls): raise RuntimeError('synthetic-boot-changed')
                return record
            def fresh(*args, **kwargs):
                if fault == 'pending' and any(k == 'stop' for k, _ in calls): raise RuntimeError('synthetic-job-pending')
            def definition(actor):
                return {'synthetic': 'changed'} if fault == 'definition' and any(k == 'stop' for k, _ in calls) else record['admin']
            def write_new(name, value):
                with (recovery / name).open('xb') as output: output.write(value)
            def protected(path, limit=262144): return Path(path).read_bytes(), []
            def bound():
                value = record['bindings'].copy()
                if fault and fault.startswith('post-rollback-') and any(k == 'rollback' for k, _ in calls): value['synthetic-' + fault[len('post-rollback-'):]] = 'changed'
                if fault == 'audit-config' and (recovery / 'recovery-completed').exists(): value['synthetic-config'] = 'changed'
                return value
            changes = {'RECOVERY': recovery, 'create_recovery': lambda: recovery.mkdir(mode=0o700), 'initial': lambda: record, 'saved': saved, 'fresh': fresh, 'bindings': bound, 'admin': actor, 'definition': definition, 'socket_probe': lambda: record['socket'], 'pins': lambda: record['pins'], 'locked': lambda callback: callback(), 'command': command, 'write_new': write_new, 'protected': protected, 'config': lambda: {'FCD_STOP_GRACE_MS': '1000', 'FCD_ADMIN_SOCKET_ROOT': str(parent / 'synthetic-socket'), 'FCD_READY_TIMEOUT_SECONDS': '2'}}
            with contextlib.ExitStack() as stack:
                for key, value in changes.items(): stack.enter_context(patch.object(module, key, value))
                stack.enter_context(patch.object(sys, 'argv', ['synthetic-action', '--recover']))
                stack.enter_context(contextlib.redirect_stdout(__import__('io').StringIO()))
                if fault and not fault.startswith('post-rollback-') and fault != 'audit-config':
                    with self.assertRaises(RuntimeError): module.main()
                    self.assertFalse((recovery / 'recovery-completed').exists())
                    self.assertNotIn('rollback', [kind for kind, _ in calls])
                    if fault in ['stop', 'recover', 'ack', 'boot', 'pending', 'definition']:
                        self.assertNotIn('start', [kind for kind, _ in calls])
                else:
                    module.main(); self.assertEqual((recovery / 'recovery-completed').read_bytes(), b'completed\n')
                    if repeat:
                        before = len(calls)
                        with self.assertRaises(FileExistsError): module.main()
                        self.assertEqual(len(calls), before)
                    if fault == 'audit-config':
                        with patch.object(sys, 'argv', ['synthetic-action', '--audit']):
                            with self.assertRaises(RuntimeError): module.main()
                    if rollback and fault and fault.startswith('post-rollback-'):
                        with patch.object(sys, 'argv', ['synthetic-action', '--rollback']):
                            with self.assertRaises(RuntimeError): module.main()
                        self.assertFalse((recovery / 'rollback-completed').exists())
                    elif rollback:
                        with patch.object(sys, 'argv', ['synthetic-action', '--rollback']): module.main()
                        self.assertEqual((recovery / 'rollback-completed').read_bytes(), b'completed\n')
                        before = len(calls)
                        with patch.object(sys, 'argv', ['synthetic-action', '--rollback']):
                            with self.assertRaises(RuntimeError): module.main()
                        self.assertEqual(len(calls), before)
            return calls

    def test_recovery_stops_and_starts_only_same_actor_after_public_ack(self):
        calls = self.exercise()
        self.assertEqual([kind for kind, _ in calls], ['stop', 'recover', 'start', 'verify'])
        self.assertEqual(calls[0][1][-1], 'synthetic-admin')
        self.assertEqual(calls[2][1][-1], 'synthetic-admin')
        self.assertIn('--confirm-admin-stopped', calls[1][1])

    def test_refusals_and_changed_bindings_never_grant_recovery_completion(self):
        for fault in ['stop', 'recover', 'ack', 'boot', 'pending', 'definition', 'start', 'verify']:
            with self.subTest(fault=fault): self.exercise(fault=fault)

    def test_recovery_namespace_is_single_use(self):
        self.exercise(repeat=True)

    def test_rollback_requires_successful_recovery_and_is_single_use(self):
        calls = self.exercise(rollback=True)
        self.assertEqual([kind for kind, _ in calls], ['stop', 'recover', 'start', 'verify', 'verify', 'rollback', 'verify'])
        self.assertIn('--confirm-schema-compatible', calls[-2][1])

    def test_missing_recovery_acknowledgement_blocks_rollback_before_commands(self):
        record = {'synthetic': 'baseline'}
        with patch.object(sys, 'argv', ['synthetic-action', '--rollback']), patch.object(module, 'saved', return_value=record), patch.object(module, 'protected', side_effect=RuntimeError('synthetic-ack-missing')) as read, patch.object(module, 'command') as command:
            with self.assertRaises(RuntimeError): module.main()
            read.assert_called_once_with(module.RECOVERY / 'recovery-completed')
            command.assert_not_called()

    def test_success_acknowledgements_do_not_hide_post_rollback_immutable_drift(self):
        for field in ['config', 'secret-metadata', 'restore-record']:
            with self.subTest(field=field): self.exercise(fault='post-rollback-' + field, rollback=True)

    def test_audit_checks_fresh_immutable_bindings(self):
        self.exercise(fault='audit-config')


if __name__ == '__main__':
    unittest.main()
