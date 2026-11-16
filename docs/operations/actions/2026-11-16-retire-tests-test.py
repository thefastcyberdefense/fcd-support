"""Authored fake-port controls for owner-approved FCD test retirement."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory

path = Path(__file__).with_name('2026-11-16-retire-tests.py')
spec = importlib.util.spec_from_file_location('retire_tests', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SCOPE = 'fcd-support-host-test-p6-abcdef0'
A = 'a' * 64
B = 'b' * 64
IMAGE = 'sha256:' + 'c' * 64


def fixture():
    return {
        'actors': [
            {'id': A, 'name': SCOPE + '-postgres-1', 'project': SCOPE,
             'synthetic': SCOPE, 'image': IMAGE, 'mounts': [], 'networks': ['owned']},
            {'id': B, 'name': 'synthetic-other-project', 'project': 'synthetic-other',
             'synthetic': '', 'image': 'sha256:' + 'd' * 64, 'mounts': [], 'networks': []},
        ],
        'volumes': [{'name': SCOPE + '-postgres', 'project': SCOPE,
                     'synthetic': '', 'driver': 'local', 'scope': 'local', 'options': None}],
        'networks': [{'id': 'e' * 64, 'name': SCOPE + '-data', 'project': SCOPE,
                      'synthetic': '', 'driver': 'bridge', 'members': [A]}],
        'images': [{'id': IMAGE, 'tags': [SCOPE + '-application:synthetic'], 'digests': []}],
        'timers': [{'active': 'inactive', 'enabled': 'disabled'}] * 3,
        'services': ['inactive'] * 3,
        'roots': [],
    }


class RetirementTests(unittest.TestCase):
    def setUp(self):
        for name, value in [('EXPECTED_ACTORS', {SCOPE + '-postgres-1'}), ('EXPECTED_VOLUMES', {SCOPE + '-postgres'}), ('OLD_SCOPES', ['abcdef0'])]:
            patcher = patch.object(module, name, value, create=True); patcher.start(); self.addCleanup(patcher.stop)

    def test_selects_only_fcd_resources_and_preserves_foreign_actor(self):
        plan = module.select_plan(fixture())
        self.assertEqual([row['id'] for row in plan['actors']], [A])
        self.assertEqual(plan['protected_actor_ids'], [B])
        self.assertEqual(len(plan['volumes']), 1)

    def test_active_timer_or_service_refuses_before_action(self):
        for field in ['timers', 'services']:
            value = fixture()
            if field == 'timers': value[field][0] = {'active': 'active', 'enabled': 'enabled'}
            else: value[field][0] = 'activating'
            with self.assertRaises(module.Refusal): module.select_plan(value)

    def test_foreign_volume_consumer_refuses(self):
        value = fixture()
        value['actors'][1]['mounts'] = [{'Type': 'volume', 'Name': SCOPE + '-postgres'}]
        with self.assertRaises(module.Refusal): module.select_plan(value)

    def test_foreign_network_member_refuses(self):
        value = fixture(); value['networks'][0]['members'].append(B)
        with self.assertRaises(module.Refusal): module.select_plan(value)

    def test_foreign_label_cannot_be_adopted_by_fcd_name(self):
        value = fixture(); value['actors'][0]['project'] = 'synthetic-other'
        with self.assertRaises(module.Refusal): module.select_plan(value)

    def test_duplicate_actor_identity_refuses(self):
        value = fixture(); value['actors'].append(copy.deepcopy(value['actors'][0]))
        with self.assertRaises(module.Refusal): module.select_plan(value)

    def test_shared_image_is_preserved(self):
        value = fixture(); value['actors'][1]['image'] = IMAGE
        self.assertEqual(module.select_plan(value)['images'], [])

    def test_mixed_repository_image_tags_are_preserved(self):
        value = fixture(); value['images'][0]['tags'].append('synthetic-other:latest')
        self.assertEqual(module.select_plan(value)['images'], [])

    def test_aliased_root_or_foreign_bind_refuses(self):
        value = fixture()
        value['roots'] = [{'path': '/home/redwan/' + SCOPE, 'canonical': False}]
        with self.assertRaises(module.Refusal): module.select_plan(value)
        value['roots'][0]['canonical'] = True
        value['actors'][1]['mounts'] = [{'Type': 'bind', 'Source': '/home/redwan/' + SCOPE + '/data'}]
        with self.assertRaises(module.Refusal): module.select_plan(value)

    def test_existing_action_refuses_without_any_mutation(self):
        class FakeReader:
            calls = []
            def snapshot(self): return fixture()
            def docker(self, *args): self.calls.append(args)
        with TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            action = home / 'already-used'; action.mkdir()
            reader = FakeReader()
            with patch.object(module, 'HOME', home), patch.object(module, 'ACTION', action), \
                 patch.object(module.sys, 'platform', 'linux'), \
                 patch.object(module.os, 'getuid', return_value=1000, create=True), \
                 patch.object(module.os, 'getgid', return_value=1000, create=True), \
                 patch.object(module.os, 'O_NOFOLLOW', 0, create=True):
                with self.assertRaises(module.Refusal): module.execute(reader)
            self.assertEqual(reader.calls, [])

    def test_partial_failure_is_recorded_and_cannot_be_replayed(self):
        class FakeReader:
            def __init__(self): self.calls = []
            def snapshot(self): return fixture()
            def docker(self, *args):
                self.calls.append(args)
                raise module.Refusal('synthetic_failure')
        with TemporaryDirectory() as directory:
            home = Path(directory).resolve(); action = home / 'one-use'; reader = FakeReader()
            with patch.object(module, 'HOME', home), patch.object(module, 'ACTION', action), \
                 patch.object(module.sys, 'platform', 'linux'), \
                 patch.object(module.os, 'getuid', return_value=1000, create=True), \
                 patch.object(module.os, 'getgid', return_value=1000, create=True), \
                 patch.object(module.os, 'O_NOFOLLOW', 0, create=True):
                with self.assertRaises(module.Refusal): module.execute(reader)
                count = len(reader.calls)
                with self.assertRaises(module.Refusal): module.execute(reader)
                self.assertEqual(len(reader.calls), count)
            self.assertEqual(__import__('json').loads((action / 'retirement.json').read_text())['phase'], 'uncertain')

    def test_recreated_volume_is_not_removed(self):
        class FakeReader:
            def __init__(self): self.calls = []
            def snapshot(self): return fixture()
            def docker(self, *args):
                self.calls.append(args)
                if args[:2] == ('network', 'inspect'): return '0'
                if args[:2] == ('volume', 'inspect'): return '{"created":"synthetic_changed"}'
                if args[:2] == ('container', 'inspect'): return 'false'
                return ''
        with TemporaryDirectory() as directory:
            home = Path(directory).resolve(); reader = FakeReader()
            with patch.object(module, 'HOME', home), patch.object(module, 'ACTION', home / 'one-use'), \
                 patch.object(module.sys, 'platform', 'linux'), \
                 patch.object(module.os, 'getuid', return_value=1000, create=True), \
                 patch.object(module.os, 'getgid', return_value=1000, create=True), \
                 patch.object(module.os, 'O_NOFOLLOW', 0, create=True):
                with self.assertRaises(module.Refusal): module.execute(reader)
            self.assertFalse(any(args[:2] == ('volume', 'rm') for args in reader.calls))

    def test_foreign_volume_bind_device_protects_its_backing_root(self):
        value = fixture(); value['roots'] = [{'path': '/home/redwan/' + SCOPE, 'canonical': True}]
        value['volumes'].append({'name': 'synthetic-foreign-data', 'project': 'synthetic-other',
                                'synthetic': '', 'driver': 'local', 'scope': 'local',
                                'options': {'type': 'none', 'o': 'bind', 'device': '/home/redwan/' + SCOPE + '/shared'}})
        with self.assertRaises(module.Refusal): module.select_plan(value)
        value['volumes'][-1]['options']['device'] = '/synthetic-alias'
        value['volumes'][-1]['canonical_bind_source'] = '/home/redwan/' + SCOPE + '/shared'
        with self.assertRaises(module.Refusal): module.select_plan(value)

    def test_unreviewed_fcd_actor_refuses_before_any_action(self):
        class FakeReader:
            def __init__(self): self.calls = []
            def snapshot(self):
                value = fixture()
                value['actors'].append({'id': 'f' * 64, 'name': 'fcd-support-production-api-1',
                                        'project': 'fcd-support-production', 'synthetic': '',
                                        'image': IMAGE, 'mounts': [], 'networks': []})
                return value
            def docker(self, *args): self.calls.append(args); raise module.Refusal('synthetic_stop')
        with TemporaryDirectory() as directory:
            home = Path(directory).resolve(); reader = FakeReader()
            with patch.object(module, 'HOME', home), patch.object(module, 'ACTION', home / 'one-use'), \
                 patch.object(module.sys, 'platform', 'linux'), \
                 patch.object(module.os, 'getuid', return_value=1000, create=True), \
                 patch.object(module.os, 'getgid', return_value=1000, create=True), \
                 patch.object(module.os, 'O_NOFOLLOW', 0, create=True):
                with self.assertRaises(module.Refusal): module.execute(reader)
            self.assertEqual(reader.calls, [])

    def test_retirement_uses_ordered_nonforce_exact_commands(self):
        plan = module.select_plan(fixture()); calls = []
        module.resource_commands(plan, lambda args: calls.append(args))
        self.assertEqual(calls[0], ['container', 'stop', '--time', '-1', A])
        self.assertEqual(calls[1], ['container', 'rm', A])
        self.assertFalse(any('prune' in args or '--force' in args for args in calls))
        self.assertLess(next(i for i,a in enumerate(calls) if a[:2] == ['container','rm']),
                        next(i for i,a in enumerate(calls) if a[:2] == ['volume','rm']))


if __name__ == '__main__': unittest.main()
