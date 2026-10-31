"""Authored allocation transition tests; no SSH, Docker or external calls."""
import copy
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rollback_after_reboot', Path(__file__).with_name('2026-10-31-rollback-after-reboot-67a4a4b.py'))
module = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'fcntl': types.ModuleType('fcntl')}): spec.loader.exec_module(module)


def fixture():
    networks = {}
    for name, subnet in [('synthetic-ingress', '192.0.2.0/24'), ('synthetic-egress', '198.51.100.0/24')]:
        networks[name] = {'Id': 'synthetic-' + name, 'IPAM': {'Config': [{'Subnet': subnet}]}, 'Status': {'IPAM': {'Subnets': {subnet: {'IPsInUse': 3, 'DynamicIPsAvailable': 251}}}}, 'UnknownStaticAttribute': 'synthetic-preserved'}
    before = {'id': 'synthetic-peer', 'command': ['-e', 'synthetic-inert-command'], 'networkIdentities': networks}
    after = copy.deepcopy(before)
    for network in after['networkIdentities'].values():
        for counts in network['Status']['IPAM']['Subnets'].values(): counts.update(IPsInUse=4, DynamicIPsAvailable=250)
    return before, after


class AllocationTransitionTests(unittest.TestCase):
    def test_exact_one_peer_allocation_passes_without_discarding_static_metadata(self):
        before, after = fixture(); module.peer_started_transition(before, after)

    def test_wrong_counts_unknown_fields_or_changed_static_identity_refuse(self):
        def counter(snapshot): return next(iter(snapshot['networkIdentities']['synthetic-ingress']['Status']['IPAM']['Subnets'].values()))
        mutations = [
            lambda x: counter(x).update(IPsInUse=5),
            lambda x: counter(x).update(DynamicIPsAvailable=249),
            lambda x: counter(x).update(IPsInUse=True),
            lambda x: counter(x).update(UnknownCounter=1),
            lambda x: x['networkIdentities']['synthetic-ingress']['Status'].update(UnknownStatus='synthetic-change'),
            lambda x: x['networkIdentities']['synthetic-ingress'].update(Id='synthetic-substitution'),
            lambda x: x['networkIdentities']['synthetic-ingress'].update(UnknownStaticAttribute='synthetic-change'),
            lambda x: x['networkIdentities']['synthetic-ingress']['IPAM']['Config'][0].update(Subnet='203.0.113.0/24'),
            lambda x: x['networkIdentities'].pop('synthetic-egress'),
            lambda x: x.update(command=['synthetic-untrusted-command']),
            lambda x: counter(x).update(DynamicIPsAvailable=-1),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                before, after = fixture(); mutate(after)
                with self.assertRaises(RuntimeError): module.peer_started_transition(before, after)


class ImmutableProofTests(unittest.TestCase):
    def test_only_deployment_state_metadata_can_change_after_rollback(self):
        record = {'source': ['synthetic-source'], 'peer': {'id': 'synthetic-peer'}, 'evidence': {'synthetic-log': 'same'}, 'bindings': {str(module.FIXTURE / 'state/deployment-state'): 'before', 'synthetic-config': 'same', 'synthetic-secret': 'same', 'synthetic-restore': 'same'}}
        for field in ['selection-metadata', 'source', 'peer', 'evidence', 'synthetic-config', 'synthetic-secret', 'synthetic-restore']:
            current = copy.deepcopy(record)
            if field == 'selection-metadata': current['bindings'][str(module.FIXTURE / 'state/deployment-state')] = 'after'
            elif field in ['source', 'peer', 'evidence']: current[field] = {'synthetic': 'changed'}
            else: current['bindings'][field] = 'changed'
            with self.subTest(field=field), patch.object(module, 'rollback_proof', return_value=current):
                if field == 'selection-metadata': module.rollback_admitted(record)
                else:
                    with self.assertRaises(RuntimeError): module.rollback_admitted(record)


class RollbackRunnerTests(unittest.TestCase):
    def exercise(self, fault=None, repeat=False):
        import contextlib, io, tempfile
        with tempfile.TemporaryDirectory(prefix='synthetic-rollback-only-') as directory:
            action = Path(directory) / 'action'; calls = []
            record = {'source': ['synthetic-source'], 'peer': {'synthetic': 'peer'}, 'evidence': {'synthetic': 'evidence'}, 'bindings': {'synthetic': 'binding'}}
            previous = {'bindings': record['bindings'], 'admin': {'synthetic': 'admin'}}
            def write(name, value):
                with (action / name).open('xb') as output: output.write(value)
            def command(args, name, timeout=2400):
                kind = {'pre-rollback-verify.log': 'pre-verify', 'rollback.log': 'rollback', 'rollback-verify.log': 'post-verify'}[name]
                if kind == 'pre-verify': self.assertFalse((action / 'rollback-started').exists())
                if kind == 'rollback': self.assertEqual((action / 'rollback-started').read_bytes(), b'started\n')
                self.assertEqual(args[0], 'bash'); self.assertNotIn('recover-admin-socket.sh', str(args))
                calls.append((kind, args))
                if fault == kind: raise RuntimeError('synthetic-command-refused')
            def admitted(value):
                if fault in ['boot', 'binding'] and calls: raise RuntimeError('synthetic-proof-changed')
                if fault == 'post-binding' and any(k == 'rollback' for k, _ in calls): raise RuntimeError('synthetic-proof-changed')
            changes = {'ROLLBACK_ACTION': action, 'rollback_proof': lambda **kw: record, 'saved': lambda: previous, 'fresh': lambda *a, **kw: None, 'bindings': lambda: previous['bindings'], 'admin': lambda: {}, 'definition': lambda a: previous['admin'], 'rollback_create': lambda: action.mkdir(), 'rollback_write': write, 'rollback_command': command, 'rollback_admitted': admitted}
            with contextlib.ExitStack() as stack:
                for key, value in changes.items(): stack.enter_context(patch.object(module, key, value))
                stack.enter_context(patch.object(sys, 'argv', ['synthetic-action', '--execute']))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                if fault:
                    with self.assertRaises(RuntimeError): module.main()
                    self.assertFalse((action / 'rollback-completed').exists())
                    if fault in ['pre-verify', 'boot', 'binding']: self.assertNotIn('rollback', [k for k, _ in calls])
                else:
                    module.main(); self.assertEqual((action / 'rollback-completed').read_bytes(), b'completed\n')
                    if repeat:
                        before = len(calls)
                        with self.assertRaises(RuntimeError): module.main()
                        self.assertEqual(before, len(calls))
            return calls

    def test_public_verify_precedes_one_rollback_then_public_verify(self):
        calls = self.exercise(); self.assertEqual([k for k, _ in calls], ['pre-verify', 'rollback', 'post-verify'])
        self.assertIn('--confirm-schema-compatible', calls[1][1])

    def test_verification_boot_binding_and_rollback_refusals_preserve_failure(self):
        for fault in ['pre-verify', 'boot', 'binding', 'rollback', 'post-verify', 'post-binding']:
            with self.subTest(fault=fault): self.exercise(fault=fault)

    def test_execution_namespace_is_single_use(self): self.exercise(repeat=True)


if __name__ == '__main__': unittest.main()
