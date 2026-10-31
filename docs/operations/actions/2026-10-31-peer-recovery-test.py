"""Synthetic peer admission/runner tests; no SSH or Docker calls."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'fcntl': types.ModuleType('fcntl')}): spec.loader.exec_module(value)
    return value


module = load('peer_recovery', '2026-10-31-peer-recovery-67a4a4b.py')
base = load('reboot_guard_cases', '2026-10-31-reboot-recovery-test.py')
base.module = module


class PeerDefinitionTests(unittest.TestCase):
    def test_inert_control_passes_but_secrets_mounts_host_network_and_substitutions_refuse(self):
        original = {'Id': 'a' * 64, 'Name': '/' + module.PROJECT + '-ingress-peer', 'Image': 'synthetic-image',
            'Config': {'User': 'node', 'Env': ['PATH=/synthetic/bin'], 'Entrypoint': ['node'], 'Cmd': ['-e', 'setInterval(()=>{},1000)'], 'Labels': {'fcd-support.synthetic-host-test': module.PROJECT, 'org.opencontainers.image.revision': module.REV}},
            'Mounts': [], 'NetworkSettings': {'Networks': {module.PROJECT + '-ingress': {}, module.PROJECT + '-egress': {}}},
            'HostConfig': {'Binds': None, 'VolumesFrom': None, 'Links': None, 'Devices': [], 'DeviceRequests': None, 'CapAdd': None, 'PidMode': '', 'IpcMode': 'private', 'UTSMode': '', 'PortBindings': {}, 'ReadonlyRootfs': True, 'Privileged': False, 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'], 'Init': True, 'NanoCpus': 250000000, 'Memory': 134217728, 'PidsLimit': 32, 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}, 'NetworkMode': module.PROJECT + '-ingress'}}
        mutations = [None,
            lambda a: a['Config']['Env'].append('SYNTHETIC_TOKEN=synthetic_not_real'),
            lambda a: a['Mounts'].append({'Source': '/synthetic/database'}),
            lambda a: a['HostConfig'].update(Binds=['/synthetic/secret:/synthetic/key']),
            lambda a: a['HostConfig'].update(NetworkMode='host'),
            lambda a: a['Config'].update(Cmd=['-e', 'synthetic_untrusted_command']),
            lambda a: a['HostConfig'].update(ReadonlyRootfs=False),
            lambda a: a['HostConfig'].update(CapAdd=['SYS_ADMIN']),
            lambda a: a.update(Image='synthetic-substitution'),
            lambda a: a['HostConfig'].update(RestartPolicy={'Name': 'always', 'MaximumRetryCount': 0}),
            lambda a: a['NetworkSettings']['Networks'].update({'synthetic-database': {}})]
        for index, mutate in enumerate(mutations):
            actor = copy.deepcopy(original)
            if mutate: mutate(actor)
            def run(args): return json.dumps([{'Config': {'Env': ['PATH=/synthetic/bin']}}] if args[1] == 'image' else [actor])
            with self.subTest(case=index), patch.object(module, 'config', return_value={'FCD_INGRESS_PEER_ID': 'a' * 64}), patch.object(module, 'admin', return_value={'Image': 'synthetic-image'}), patch.object(module, 'run', run):
                if mutate:
                    with self.assertRaises(RuntimeError): module.peer()
                else: self.assertEqual(module.peer(), actor)


class PeerRunnerTests(unittest.TestCase):
    def exercise(self, fault=None, rollback=False, repeat=False):
        with tempfile.TemporaryDirectory(prefix='synthetic-peer-recovery-') as directory:
            action = Path(directory) / 'peer'; calls = []; state = {'phase': 'exited'}
            previous = {'bindings': {'synthetic': 'binding'}, 'admin': {'synthetic': 'admin'}}
            record = {'source': ['synthetic-source'], 'peer': {'synthetic': 'peer'}}
            def actor(): return {'Id': 'synthetic-peer', 'State': {'Status': state['phase'], 'Running': state['phase'] == 'running', 'Restarting': False}}
            def saved():
                if fault in ['boot', 'bindings'] and any(k == 'start' for k, _ in calls): raise RuntimeError('synthetic-admission-changed')
                if fault == 'post-rollback' and any(k == 'rollback' for k, _ in calls): raise RuntimeError('synthetic-binding-changed')
                return previous, record
            def command(args, name, timeout=2400):
                kind = 'start' if args[0] == 'docker' else ('rollback' if Path(args[1]).name == 'rollback-runtime.sh' else 'verify')
                calls.append((kind, args))
                if fault == kind: raise RuntimeError('synthetic-command-refused')
                if kind == 'start': state['phase'] = 'running'
            def write(name, value):
                with (action / name).open('xb') as output: output.write(value)
            changes = {'PEER_ACTION': action, 'peer_initial': lambda: record, 'peer_saved': saved, 'fresh': lambda *a, **kw: None, 'bindings': lambda: previous['bindings'], 'definition': lambda a: previous['admin'], 'admin': lambda: {}, 'peer': actor, 'peer_definition': lambda a: record['peer'], 'locked': lambda callback: callback(), 'peer_create': lambda: action.mkdir(), 'peer_write': write, 'peer_command': command, 'protected': lambda path, *args: (Path(path).read_bytes(), [])}
            with contextlib.ExitStack() as stack:
                for key, value in changes.items(): stack.enter_context(patch.object(module, key, value))
                stack.enter_context(patch.object(sys, 'argv', ['synthetic-action', '--recover']))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                if fault and fault not in ['rollback', 'post-rollback']:
                    with self.assertRaises(RuntimeError): module.main()
                    self.assertFalse((action / 'runtime-completed').exists())
                    if fault in ['boot', 'bindings']: self.assertNotIn('verify', [k for k, _ in calls])
                else:
                    module.main(); self.assertEqual((action / 'runtime-completed').read_bytes(), b'completed\n')
                    if repeat:
                        before = len(calls)
                        with self.assertRaises(FileExistsError): module.main()
                        self.assertEqual(len(calls), before)
                    if rollback:
                        with patch.object(sys, 'argv', ['synthetic-action', '--rollback']):
                            if fault:
                                with self.assertRaises(RuntimeError): module.main()
                                self.assertFalse((action / 'rollback-completed').exists())
                            else:
                                module.main(); self.assertEqual((action / 'rollback-completed').read_bytes(), b'completed\n')
                                before = len(calls)
                                with self.assertRaises(RuntimeError): module.main()
                                self.assertEqual(len(calls), before)
            return calls

    def test_start_only_same_canary_then_public_verify(self):
        calls = self.exercise()
        self.assertEqual([k for k, _ in calls], ['start', 'verify'])
        self.assertEqual(calls[0][1], ['docker', 'container', 'start', 'synthetic-peer'])
        self.assertNotIn('recover-admin-socket.sh', str(calls))

    def test_start_verify_and_changed_boot_bindings_fail_without_completion(self):
        for fault in ['start', 'verify', 'boot', 'bindings']:
            with self.subTest(fault=fault): self.exercise(fault=fault)

    def test_peer_recovery_is_single_use(self): self.exercise(repeat=True)

    def test_separate_rollback_is_verified_and_single_use(self):
        calls = self.exercise(rollback=True)
        self.assertEqual([k for k, _ in calls], ['start', 'verify', 'verify', 'rollback', 'verify'])
        self.assertIn('--confirm-schema-compatible', calls[-2][1])

    def test_failed_or_changed_rollback_cannot_record_completion(self):
        for fault in ['rollback', 'post-rollback']:
            with self.subTest(fault=fault): self.exercise(fault=fault, rollback=True)

    def test_missing_new_runtime_completion_blocks_rollback(self):
        with patch.object(sys, 'argv', ['synthetic-action', '--rollback']), patch.object(module, 'peer_saved', return_value=({}, {})), patch.object(module, 'protected', side_effect=RuntimeError('synthetic-ack-missing')), patch.object(module, 'peer_command') as command:
            with self.assertRaises(RuntimeError): module.main()
            command.assert_not_called()


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for case in [base.RebootPreservationTests, base.PreservedRestartPolicyTests, PeerDefinitionTests, PeerRunnerTests]: suite.addTests(loader.loadTestsFromTestCase(case))
    return suite


if __name__ == '__main__': unittest.main()
