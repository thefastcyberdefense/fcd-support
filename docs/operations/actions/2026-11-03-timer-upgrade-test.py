"""Hermetic guards only: never calls SSH, Docker, systemd or the upgrade entrypoint."""
import importlib.util
import copy
from pathlib import Path
import unittest
from unittest import mock

path = Path(__file__).with_name('2026-11-03-timer-upgrade.py')
module = None
if path.exists():
    spec = importlib.util.spec_from_file_location('timer_upgrade', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(module, 'reviewed upgrade configuration guard is not implemented')
        self.old = 'a' * 40
        self.new = 'b' * 40
        self.project = 'fcd-support-host-test-synthetic'
        self.config = ('FCD_SUPPORT_REVISION=' + self.old + '\n'
                       'FCD_SUPPORT_IMAGE=' + self.project + '-application:' + self.old + '\n'
                       'FCD_OPERATIONS_IMAGE=' + self.project + '-operations:' + self.old + '\n'
                       'FCD_POSTGRES_IMAGE=' + self.project + '-postgres:' + self.old + '\n'
                       'FCD_RUNTIME_PROJECT=' + self.project + '\n'
                       'FCD_ADMIN_SOCKET_ROOT=/synthetic/socket\n').encode()

    def test_only_four_pins_change_and_all_other_bytes_remain(self):
        result = module.upgrade_configuration(self.config, self.project, self.old, self.new)
        self.assertEqual(result, self.config.replace(self.old.encode(), self.new.encode()))

    def test_duplicate_missing_or_unknown_old_pin_refuses(self):
        for data in [self.config + b'FCD_SUPPORT_REVISION=' + self.old.encode() + b'\n',
                     self.config.replace(b'FCD_SUPPORT_REVISION=', b'SYNTHETIC_OTHER='),
                     self.config.replace((self.project + '-operations').encode(), b'synthetic_foreign')]:
            with self.subTest(data_length=len(data)), self.assertRaises(RuntimeError):
                module.upgrade_configuration(data, self.project, self.old, self.new)

    def test_newline_nul_non_ascii_or_oversize_refuses(self):
        for data in [self.config.rstrip(b'\n'), self.config + b'\x00', self.config + b'\xff', self.config * 1000]:
            with self.subTest(data_length=len(data)), self.assertRaises(RuntimeError):
                module.upgrade_configuration(data, self.project, self.old, self.new)

    def test_changed_same_or_invalid_revision_refuses(self):
        for old, new in [('c' * 40, self.new), (self.old, self.old), (self.old, 'main'), (self.old, 'b' * 39)]:
            with self.subTest(old=old, new=new), self.assertRaises(RuntimeError):
                module.upgrade_configuration(self.config, self.project, old, new)


class ObservedWindowTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(callable(getattr(module, 'qualify_observed_window', None)))
        self.before = {'actors': [], 'networks': [{'members': {}}], 'volumes': ['synthetic_volume'],
                       'files': {'synthetic_state': 'synthetic_fingerprint'}, 'pins': ['synthetic_boot']}
        for index in range(5):
            ident = 'synthetic_actor_' + str(index)
            self.before['actors'].append({'id': ident, 'state': 'exited' if index == 4 else 'running',
                'health': 'healthy' if index < 2 else 'none', 'restarts': 1 if index == 0 else 0,
                'static': {'name': '/synthetic_other_' + str(index), 'owner': 'synthetic_other',
                    'synthetic': None, 'started': '2030-04-14T00:00:00.000000000Z',
                    'networks': {'synthetic_bridge': {'EndpointID': 'synthetic_old', 'MacAddress': 'synthetic_old', 'IP': '192.0.2.10'}}}})
            self.before['networks'][0]['members'][ident] = {'EndpointID': 'synthetic_old', 'MacAddress': 'synthetic_old', 'IP': '192.0.2.10'}
        self.after = copy.deepcopy(self.before)
        for row in self.after['actors']:
            row['restarts'] = 0; row['static']['started'] = '2030-04-14T01:00:10.000000000Z'
            row['static']['networks']['synthetic_bridge']['EndpointID'] = 'synthetic_new'
            row['static']['networks']['synthetic_bridge']['MacAddress'] = 'synthetic_new'
            self.after['networks'][0]['members'][row['id']].update({'EndpointID': 'synthetic_new', 'MacAddress': 'synthetic_new'})

    def qualify(self, after):
        return module.qualify_observed_window(self.before, after, 'synthetic_legacy_admin', lambda a, b, _: a == b,
              '2030-04-14T01:00:00.000000000Z', '2030-04-14T01:00:20.000000000Z')

    def test_exact_observed_window_preserves_inputs_and_all_other_metadata(self):
        saved = copy.deepcopy(self.before); current = copy.deepcopy(self.after)
        self.assertEqual(len(self.qualify(self.after)), 5)
        self.assertEqual(self.before, saved); self.assertEqual(self.after, current)

    def test_loss_added_actor_config_ip_volume_file_or_boot_drift_refuses(self):
        for kind in ['loss', 'addition', 'config', 'ip', 'volume', 'file', 'boot']:
            changed = copy.deepcopy(self.after)
            if kind == 'loss': changed['actors'].pop()
            elif kind == 'addition': changed['actors'].append(copy.deepcopy(changed['actors'][0]))
            elif kind == 'config': changed['actors'][0]['static']['name'] = '/synthetic_changed'
            elif kind == 'ip': changed['networks'][0]['members']['synthetic_actor_0']['IP'] = '192.0.2.11'
            elif kind == 'volume': changed['volumes'] = []
            elif kind == 'file': changed['files'] = {}
            else: changed['pins'] = []
            with self.subTest(kind=kind), self.assertRaises(RuntimeError): self.qualify(changed)

    def test_new_window_counter_delta_or_health_change_refuses(self):
        for kind in ['time', 'counter', 'health', 'state']:
            changed = copy.deepcopy(self.after)
            if kind == 'time': changed['actors'][0]['static']['started'] = '2030-04-14T02:00:00.000000000Z'
            elif kind == 'counter': changed['actors'][0]['restarts'] = 1
            elif kind == 'health': changed['actors'][0]['health'] = 'unhealthy'
            else: changed['actors'][0]['state'] = 'exited'
            with self.subTest(kind=kind), self.assertRaises(RuntimeError): self.qualify(changed)

    def test_fcd_or_synthetic_owned_actor_cannot_use_other_project_qualification(self):
        for field, value in [('owner', 'fcd-support-synthetic'), ('synthetic', 'synthetic_fixture'), ('name', '/fcd-support-synthetic')]:
            before = copy.deepcopy(self.before); after = copy.deepcopy(self.after)
            before['actors'][0]['static'][field] = value; after['actors'][0]['static'][field] = value
            with mock.patch.object(self, 'before', before), self.assertRaises(RuntimeError): self.qualify(after)


if __name__ == '__main__':
    unittest.main()
