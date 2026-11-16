"""Authored admission/command tests for the fresh private version-one deployment."""
import importlib.util
from pathlib import Path
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('private_v1', Path(__file__).with_name('2026-11-16-private-v1.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def fixture():
    return {'retirement_complete': True, 'disk_mib': 12288, 'memory_mib': 2048,
            'old_fcd_resources': False, 'namespace_absent': True, 'paths_absent': True,
            'paths_disjoint': True, 'fixture_node_ready': True, 'network_blocks': ['172.18.0.0/16']}


class PrivateDeploymentTests(unittest.TestCase):
    def test_accepts_exact_existing_admission_floors(self):
        self.assertEqual(m.admit(fixture()), '198.19.0.0/20')

    def test_incomplete_retirement_and_collisions_refuse(self):
        for key in ['retirement_complete', 'namespace_absent', 'paths_absent', 'paths_disjoint', 'fixture_node_ready']:
            value = fixture(); value[key] = False
            with self.assertRaises(m.Refusal): m.admit(value)
        value = fixture(); value['old_fcd_resources'] = True
        with self.assertRaises(m.Refusal): m.admit(value)

    def test_resource_shortfalls_refuse(self):
        for key, floor in [('disk_mib', 12288), ('memory_mib', 2048)]:
            value = fixture(); value[key] = floor - 1
            with self.assertRaises(m.Refusal): m.admit(value)

    def test_network_selection_does_not_overlap_foreign_networks(self):
        value = fixture(); value['network_blocks'].append('198.19.0.0/20')
        self.assertEqual(m.admit(value), '198.19.16.0/20')
        value['network_blocks'] = ['198.19.0.0/16']
        with self.assertRaises(m.Refusal): m.admit(value)

    def test_only_accepted_revision_is_deployed_through_public_controllers(self):
        commands = m.lifecycle_commands()
        self.assertIn('--mode', commands[0])
        self.assertIn('private-disabled', commands[0])
        self.assertEqual(commands[0][1], str(m.SOURCE / 'scripts/deploy-runtime.sh'))
        self.assertEqual(commands[1][1], str(m.SOURCE / 'scripts/verify-runtime.sh'))
        self.assertTrue(all(m.REVISION in command for command in commands))

    def test_protocol_files_use_real_line_terminators(self):
        with TemporaryDirectory() as directory, patch.object(m.os, 'O_NOFOLLOW', 0, create=True):
            target = Path(directory) / 'synthetic-recipient'
            m.write_protocol_line(target, 'synthetic_age_recipient')
            self.assertEqual(target.read_bytes(), b'synthetic_age_recipient\n')
            config = Path(directory) / 'synthetic-operations.env'
            config.write_bytes(b'SYNTHETIC_INITIAL=value\n')
            m.write_protocol_line(config, 'FCD_INGRESS_PEER_ID=synthetic_peer', append=True)
            self.assertEqual(config.read_bytes(), b'SYNTHETIC_INITIAL=value\nFCD_INGRESS_PEER_ID=synthetic_peer\n')

    def test_collector_refuses_an_existing_deployment_image_tag(self):
        state = {'actors': [], 'volumes': [], 'networks': [], 'images': [
            {'tags': [m.PROJECT + '-application:' + m.REVISION]}]}
        class Retirement:
            @staticmethod
            def is_fcd(value): return value.startswith('fcd-support')
        class FakeReader(m.Reader):
            def resources(self): return state, Retirement
            def fixture_node(self): return 'synthetic_fixture_node'
            def docker(self, *args): return ''
            def run(self, args, **kwargs):
                if args[0] == 'df': return 'Filesystem 1K-blocks Used Available Capacity Mounted\nsynthetic 99999999 1 12582912 1% /'
                if args[0] == 'ip': return '[]'
                raise AssertionError('Unexpected synthetic port')
        def read_text(path, *args, **kwargs):
            if str(path).endswith('meminfo'): return 'MemAvailable: 2097152 kB\n'
            return '{"phase":"complete"}'
        with patch.object(Path, 'read_text', read_text), patch.object(Path, 'is_file', return_value=True), \
             patch.object(Path, 'exists', return_value=False), patch.object(Path, 'is_symlink', return_value=False):
            observation, _ = FakeReader().admission()
        self.assertFalse(observation['namespace_absent'])
        with self.assertRaises(m.Refusal): m.admit(observation)

    def test_prepared_source_requires_the_exact_pre_resource_failure(self):
        valid = {'phase':'uncertain','stage':'fixture','revision':m.REVISION}
        self.assertTrue(m.prepared_source_allowed(valid,m.REVISION,False))
        for field,value in [('stage','images'),('phase','complete'),('revision','a'*40)]:
            changed = dict(valid); changed[field]=value
            with self.assertRaises(m.Refusal): m.prepared_source_allowed(changed,m.REVISION,False)
        with self.assertRaises(m.Refusal):m.prepared_source_allowed(valid,m.REVISION,True)

    def test_bad_network_is_rejected(self):
        value = fixture(); value['network_blocks'] = ['synthetic_invalid_cidr']
        with self.assertRaises(m.Refusal): m.admit(value)


if __name__ == '__main__': unittest.main()
