import copy
import importlib.util
from pathlib import Path
import unittest
from unittest import mock
import os
import sys
import tempfile
import time
import subprocess

spec = importlib.util.spec_from_file_location('final_server', Path(__file__).with_name('2026-11-02-final-server.py'))
action = importlib.util.module_from_spec(spec)
spec.loader.exec_module(action)


class FinalServerTests(unittest.TestCase):
    def snapshot(self):
        return {'actors': [{'id': 'synthetic_admin', 'static': {'image': 'synthetic_image', 'networks': ['synthetic_admin_data']}, 'state': 'restarting', 'health': 'unhealthy', 'restarts': 4}, {'id': 'synthetic_other', 'static': {'image': 'synthetic_other_image'}, 'state': 'running', 'health': 'healthy', 'restarts': 0}], 'networks': [{'id': 'synthetic_bridge'}], 'volumes': [{'name': 'synthetic_volume'}], 'files': {'synthetic_state': 'synthetic_fingerprint'}, 'pins': {'boot': 'synthetic_boot', 'daemon': 'synthetic_daemon'}}

    def test_source_scope_accepts_full_revision_only(self):
        self.assertEqual(action.source_scope('a' * 40), 'fcd-support-host-test-p6-' + 'a' * 7)
        for value in ['main', 'a' * 7, '../synthetic', 'A' * 40, 'a' * 40 + '\n', '', None]:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                action.source_scope(value)

    def test_checkout_cannot_change_a_mounted_source_or_parent(self):
        self.assertTrue(action.source_disjoint(['/home/redwan/apps/synthetic_other', '/home/redwan/apps/fcd-support-synthetic-sibling']))
        for path in ['/home/redwan/apps', '/home/redwan/apps/fcd-support', '/home/redwan/apps/fcd-support/src']:
            with self.subTest(path=path):
                self.assertFalse(action.source_disjoint([path]))

    def test_git_commands_run_inside_selected_repository(self):
        with tempfile.TemporaryDirectory(prefix='synthetic_final_git_') as name, mock.patch.object(action, 'ROOT', Path(name)):
            subprocess.run(['git', '-C', name, 'init', '--quiet'], check=True, capture_output=True)
            self.assertEqual(Path(action.run(['git', 'rev-parse', '--show-toplevel'])).resolve(), Path(name).resolve())

    def test_network_checks_containment_in_both_directions(self):
        self.assertTrue(action.network_free(['198.19.32.0/24'], ['192.168.10.0/24']))
        for current in ['198.19.32.0/25', '198.19.0.0/16', '198.19.32.0/24']:
            with self.subTest(current=current):
                self.assertFalse(action.network_free(['198.19.32.0/24'], [current]))
        self.assertFalse(action.network_free(['198.19.32.0/24', '198.19.32.0/25'], []))

    def test_preservation_accepts_only_known_admin_restart_cycle(self):
        before = self.snapshot()
        after = copy.deepcopy(before)
        after['actors'][0]['state'] = 'running'
        after['actors'][0]['restarts'] = 5
        self.assertTrue(action.preserved(before, after, 'synthetic_admin'))

    def test_other_project_state_or_definition_change_refused(self):
        before = self.snapshot()
        for field, value in [('state', 'exited'), ('health', 'unhealthy'), ('restarts', 1), ('static', {'image': 'synthetic_replaced'})]:
            after = copy.deepcopy(before)
            after['actors'][1][field] = value
            with self.subTest(field=field):
                self.assertFalse(action.preserved(before, after, 'synthetic_admin'))

    def test_admin_replacement_topology_or_counter_reset_refused(self):
        before = self.snapshot()
        for field, value in [('id', 'synthetic_replacement'), ('static', {'image': 'synthetic_replaced'}), ('state', 'exited'), ('health', 'healthy'), ('restarts', 3)]:
            after = copy.deepcopy(before)
            after['actors'][0][field] = value
            with self.subTest(field=field):
                self.assertFalse(action.preserved(before, after, 'synthetic_admin'))

    def test_missing_old_actor_file_volume_or_boot_change_refused(self):
        before = self.snapshot()
        for field in ['actors', 'networks', 'volumes', 'files', 'pins']:
            after = copy.deepcopy(before)
            after[field] = []
            with self.subTest(field=field):
                self.assertFalse(action.preserved(before, after, 'synthetic_admin'))

    def test_unit_collision_or_existing_load_refused(self):
        absent = [{'exists': False, 'load': 'not-found', 'fragment': ''} for _ in range(4)]
        self.assertTrue(action.unit_admission(absent))
        for field, value in [('exists', True), ('load', 'loaded'), ('fragment', '/synthetic/unit')]:
            rows = copy.deepcopy(absent)
            rows[1][field] = value
            with self.subTest(field=field):
                self.assertFalse(action.unit_admission(rows))
        self.assertFalse(action.unit_admission(absent[:3]))

    def test_template_admission_queries_a_concrete_service_instance(self):
        def systemctl(args, **kwargs):
            if 'fcd-support-operation@.service' in args:
                raise RuntimeError('synthetic_systemctl_empty_instance_refused')
            return 'not-found' if 'LoadState' in args else ''
        with mock.patch.object(action, 'run', side_effect=systemctl), mock.patch.object(action.os.path, 'lexists', return_value=False):
            self.assertTrue(action.unit_admission(action.timer_rows()))

    def test_subnet_inventory_includes_policy_table_host_routes(self):
        def inventory(args, **kwargs):
            if args[:3] == ['docker', 'network', 'ls']:
                return ''
            if 'route' in args and 'all' in args:
                return '[{"dst":"198.19.32.9","table":123}]'
            return '[]'
        with mock.patch.object(action, 'run', side_effect=inventory):
            self.assertFalse(action.network_free(['198.19.32.0/24'], action.subnets()))

    def test_subnet_inventory_includes_actual_interface_prefixes(self):
        def inventory(args, **kwargs):
            if args[:3] == ['docker', 'network', 'ls']:
                return ''
            if 'addr' in args:
                return '[{"addr_info":[{"family":"inet","local":"198.19.32.5","prefixlen":24}]}]'
            return '[]'
        with mock.patch.object(action, 'run', side_effect=inventory):
            self.assertFalse(action.network_free(['198.19.32.0/24'], action.subnets()))

    @unittest.skipUnless(os.name == 'posix', 'real Unix process groups required')
    def test_early_failed_leader_does_not_leave_writing_descendant(self):
        self.check_descendant(1)

    @unittest.skipUnless(os.name == 'posix', 'real Unix process groups required')
    def test_early_successful_leader_cannot_hide_live_descendant(self):
        self.check_descendant(0)

    @unittest.skipUnless(os.name == 'posix', 'real Unix process groups required')
    def test_timeout_reaps_owned_group_before_refusal(self):
        with tempfile.TemporaryDirectory(prefix='synthetic_final_action_') as name, mock.patch.object(action, 'ROOT', Path(name)):
            with self.assertRaises(Exception):
                action.logged([sys.executable, '-c', 'import time; time.sleep(30)'], Path(name)/'timeout.log', timeout=0.1)

    def check_descendant(self, result):
        with tempfile.TemporaryDirectory(prefix='synthetic_final_action_') as name, mock.patch.object(action, 'ROOT', Path(name)):
            marker=Path(name)/'synthetic_descendant'
            descendant='import pathlib,time; time.sleep(0.5); pathlib.Path('+repr(str(marker))+').write_text("synthetic")'
            leader='import subprocess,sys; subprocess.Popen([sys.executable,"-c",'+repr(descendant)+']); sys.exit('+str(result)+')'
            with self.assertRaises(RuntimeError):
                action.logged([sys.executable, '-c', leader], Path(name)/'leader.log', timeout=2)
            time.sleep(0.7)
            self.assertFalse(marker.exists(), 'owned descendant survived action refusal')


if __name__ == '__main__':
    unittest.main()
