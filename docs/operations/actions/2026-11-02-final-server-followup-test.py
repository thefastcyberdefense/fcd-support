import copy
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('final_followup', Path(__file__).with_name('2026-11-02-final-server-followup.py'))
action = importlib.util.module_from_spec(spec)
spec.loader.exec_module(action)
base_spec = importlib.util.spec_from_file_location('original_final_tests', Path(__file__).with_name('2026-11-02-final-server-test.py'))
base_tests = importlib.util.module_from_spec(base_spec)
base_spec.loader.exec_module(base_tests)
base_tests.action = action


class InheritedGuardTests(base_tests.FinalServerTests):
    pass

class FollowupTests(unittest.TestCase):
    def baseline(self):
        return {'actors': [
            {'id': 'synthetic_admin', 'static': {'name': '/fcd-support-synthetic-admin', 'owner': 'fcd-support-synthetic', 'synthetic': None}, 'state': 'restarting', 'health': 'unhealthy', 'restarts': 4},
            {'id': 'synthetic_absent', 'static': {'name': '/synthetic_other_job', 'owner': 'synthetic_other_project', 'synthetic': None}, 'state': 'running', 'health': 'none', 'restarts': 0},
            {'id': 'synthetic_survivor', 'static': {'name': '/synthetic_survivor', 'owner': 'synthetic_survivor_project', 'synthetic': None}, 'state': 'running', 'health': 'healthy', 'restarts': 0}],
            'networks': [{'id': 'synthetic_bridge', 'members': {'synthetic_absent': {'Name': 'synthetic_other_job'}, 'synthetic_survivor': {'Name': 'synthetic_survivor'}}}],
            'volumes': [{'name': 'synthetic_volume'}], 'files': {'synthetic_state': 'synthetic_fingerprint'}, 'pins': {'boot': 'synthetic_boot', 'daemon': 'synthetic_daemon'}}

    def current(self):
        result = self.baseline()
        result['actors'].pop(1)
        result['networks'][0]['members'].pop('synthetic_absent')
        result['actors'][0]['restarts'] += 1
        return result

    def test_qualifies_only_one_absent_unrelated_running_actor_without_mutating_baseline(self):
        before, after = self.baseline(), self.current()
        saved = copy.deepcopy(before)
        self.assertEqual(action.qualify_prior_loss(before, after, 'synthetic_admin'), ['synthetic_absent'])
        self.assertEqual(before, saved)
        self.assertFalse(action.preserved(before, after, 'synthetic_admin'))

    def test_no_missing_actor_or_second_loss_is_refused(self):
        for after in [self.baseline(), self.current()]:
            if after != self.baseline():
                after['actors'].pop()
                after['networks'][0]['members'].pop('synthetic_survivor')
            with self.subTest(after=after), self.assertRaises(RuntimeError):
                action.qualify_prior_loss(self.baseline(), after, 'synthetic_admin')

    def test_missing_fcd_or_nonrunning_actor_is_not_qualified(self):
        for field, value in [('owner', 'fcd-support-synthetic'), ('synthetic', 'synthetic_scope'), ('name', '/fcd-support-synthetic')]:
            before=self.baseline(); before['actors'][1]['static'][field]=value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                action.qualify_prior_loss(before, self.current(), 'synthetic_admin')
        before=self.baseline(); before['actors'][1]['state']='exited'
        with self.assertRaises(RuntimeError):
            action.qualify_prior_loss(before, self.current(), 'synthetic_admin')

    def test_no_other_inventory_or_pin_change_can_be_qualified(self):
        for field in ['networks', 'volumes', 'files', 'pins']:
            after=self.current(); after[field]=[]
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                action.qualify_prior_loss(self.baseline(), after, 'synthetic_admin')
        after=self.current(); after['actors'][1]['health']='unhealthy'
        with self.assertRaises(RuntimeError):
            action.qualify_prior_loss(self.baseline(), after, 'synthetic_admin')

    def test_duplicate_actor_observations_are_not_collapsed(self):
        for which in ['before', 'after']:
            before,after=self.baseline(),self.current()
            target=before if which=='before' else after
            target['actors'].append(copy.deepcopy(target['actors'][0]))
            with self.subTest(which=which), self.assertRaises(RuntimeError):
                action.qualify_prior_loss(before, after, 'synthetic_admin')

    def test_fresh_block_does_not_overlap_preserved_attempt(self):
        self.assertTrue(action.network_free([action.NETWORK_BLOCK], ['198.19.32.0/20']))
        self.assertEqual(action.NETWORK_START, 48)
        for index in range(8):
            self.assertIn('198.19.'+str(action.NETWORK_START+index)+'.0/24', action.network_cidrs())

    def test_drift_between_qualification_and_baseline_cannot_be_absorbed(self):
        changed=self.current()
        changed['actors'].pop()
        changed['networks'][0]['members'].pop('synthetic_survivor')
        with mock.patch.object(action, 'snapshot', side_effect=[self.current(), changed, changed]), self.assertRaises(RuntimeError):
            action.capture_admission('fcd-support-host-test-p6-'+'a'*7, self.baseline(), 'synthetic_admin')

    def test_drift_after_qualification_is_also_refused(self):
        changed=self.current(); changed['volumes']=[]
        with mock.patch.object(action, 'snapshot', side_effect=[self.current(), self.current(), changed]), self.assertRaises(RuntimeError):
            action.capture_admission('fcd-support-host-test-p6-'+'a'*7, self.baseline(), 'synthetic_admin')

    def test_stable_qualified_admission_retains_original_snapshot(self):
        with mock.patch.object(action, 'snapshot', side_effect=[self.current(), self.current(), self.current()]):
            before,missing=action.capture_admission('fcd-support-host-test-p6-'+'a'*7, self.baseline(), 'synthetic_admin')
        self.assertEqual(before, self.current())
        self.assertEqual(missing, ['synthetic_absent'])

if __name__ == '__main__':
    unittest.main()
