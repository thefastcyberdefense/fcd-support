import copy
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('final_server_health_fixed',Path(__file__).with_name('2026-11-03-final-server.py'))
action=importlib.util.module_from_spec(spec);spec.loader.exec_module(action)
base_spec=importlib.util.spec_from_file_location('original_final_tests',Path(__file__).with_name('2026-11-02-final-server-test.py'))
base_tests=importlib.util.module_from_spec(base_spec);base_spec.loader.exec_module(base_tests);base_tests.action=action

class InheritedGuardTests(base_tests.FinalServerTests): pass

class HealthFollowupTests(unittest.TestCase):
    def baseline(self):
        return {'actors':[{'id':'synthetic_admin','static':{'name':'/fcd-support-synthetic-admin','owner':'fcd-support-synthetic','synthetic':None},'state':'restarting','health':'unhealthy','restarts':4},{'id':'synthetic_other','static':{'name':'/synthetic_other','owner':'synthetic_other_project','synthetic':None},'state':'running','health':'none','restarts':0}], 'networks':[{'id':'synthetic_bridge','members':{'synthetic_other':{'Name':'synthetic_other'}}}], 'volumes':[{'name':'synthetic_volume'}], 'files':{'synthetic_state':'synthetic_fingerprint'}, 'pins':{'boot':'synthetic_boot','daemon':'synthetic_daemon'}}

    def test_known_legacy_restart_loop_can_pass_through_starting_without_accepting_healthy(self):
        before=self.baseline();after=copy.deepcopy(before)
        after['actors'][0].update({'state':'running','health':'starting','restarts':5})
        self.assertTrue(action.preserved(before,after,'synthetic_admin'))
        after['actors'][0]['health']='healthy'
        self.assertFalse(action.preserved(before,after,'synthetic_admin'))

    def test_prior_baseline_accepts_no_new_loss_and_preserves_input(self):
        before=self.baseline();after=copy.deepcopy(before);after['actors'][0]['restarts']+=1
        self.assertEqual(action.qualify_prior_loss(before,after,'synthetic_admin'),[])
        self.assertEqual(before,self.baseline())

    def test_no_further_actor_loss_can_be_qualified(self):
        before=self.baseline();after=copy.deepcopy(before);after['actors'].pop();after['networks'][0]['members']={}
        with self.assertRaises(RuntimeError): action.qualify_prior_loss(before,after,'synthetic_admin')

    def test_other_inventory_change_is_refused(self):
        for field in ['networks','volumes','files','pins']:
            after=self.baseline();after[field]=[]
            with self.subTest(field=field),self.assertRaises(RuntimeError): action.qualify_prior_loss(self.baseline(),after,'synthetic_admin')

    def test_new_baseline_cannot_absorb_drift_before_prior_comparison(self):
        changed=self.baseline();changed['volumes']=[]
        with mock.patch.object(action,'snapshot',side_effect=[self.baseline(),changed,changed]),self.assertRaises(RuntimeError): action.capture_admission('fcd-support-host-test-p6-'+'a'*7,self.baseline(),'synthetic_admin')

    def test_new_baseline_cannot_absorb_drift_after_prior_comparison(self):
        changed=self.baseline();changed['volumes']=[]
        with mock.patch.object(action,'snapshot',side_effect=[self.baseline(),self.baseline(),changed]),self.assertRaises(RuntimeError): action.capture_admission('fcd-support-host-test-p6-'+'a'*7,self.baseline(),'synthetic_admin')

    def test_separate_block_and_both_failed_evidence_sets_are_pinned(self):
        self.assertEqual(action.NETWORK_START,64)
        self.assertTrue(action.network_free([action.NETWORK_BLOCK],['198.19.32.0/20','198.19.48.0/20']))
        self.assertEqual(set(action.PROTECTED_PRIORS),{'6d0210ddee6c333b6ce803370392a0818f5f3d29','7af70cc77196813b92d8365567150153996b790a'})
        self.assertIn('health.log',action.PROTECTED_PRIORS[action.PRIOR_REVISION])
        self.assertIn('prior-quarantine.json',action.PROTECTED_PRIORS[action.PRIOR_REVISION])

    def restarted(self):
        before=self.baseline(); actor=before['actors'][1]; actor['health']='healthy'
        actor['static'].update({'started':'2030-01-01T00:00:00.000Z','networks':{'synthetic_network':{'EndpointID':'synthetic_old','MacAddress':'02:00:00:00:00:01','IPAddress':'192.0.2.1','Aliases':['synthetic_alias'],'IPAMConfig':None}}})
        before['networks'][0]['members']['synthetic_other'].update({'EndpointID':'synthetic_old','MacAddress':'02:00:00:00:00:01','IPv4Address':'192.0.2.1/24'})
        after=copy.deepcopy(before); actor=after['actors'][1];actor['restarts']+=1;actor['static']['started']='2030-01-01T01:00:00.000Z'
        actor['static']['networks']['synthetic_network'].update({'EndpointID':'synthetic_new','MacAddress':'02:00:00:00:00:02'})
        after['networks'][0]['members']['synthetic_other'].update({'EndpointID':'synthetic_new','MacAddress':'02:00:00:00:00:02'})
        return before,after

    def test_one_observed_healthy_restart_can_qualify_only_before_the_new_baseline(self):
        before,after=self.restarted();saved=copy.deepcopy(before)
        self.assertEqual(action.qualify_prior_loss(before,after,'synthetic_admin'),['synthetic_other'])
        self.assertEqual(before,saved)
        self.assertFalse(action.preserved(before,after,'synthetic_admin'))
        self.assertTrue(action.preserved(after,copy.deepcopy(after),'synthetic_admin'))

    def test_healthy_restart_cannot_hide_health_counter_config_or_ip_drift(self):
        for field,value in [('health','unhealthy'),('state','restarting'),('restarts',2)]:
            before,after=self.restarted();after['actors'][1][field]=value
            with self.subTest(field=field),self.assertRaises(RuntimeError):action.qualify_prior_loss(before,after,'synthetic_admin')
        for field,value in [('image','synthetic_replacement'),('mounts',['synthetic_replacement']),('ports',{'synthetic':'changed'}),('policy',{'synthetic':'changed'})]:
            before,after=self.restarted();after['actors'][1]['static'][field]=value
            with self.subTest(field=field),self.assertRaises(RuntimeError):action.qualify_prior_loss(before,after,'synthetic_admin')
        before,after=self.restarted();after['actors'][1]['static']['networks']['synthetic_network']['IPAddress']='192.0.2.2'
        with self.assertRaises(RuntimeError):action.qualify_prior_loss(before,after,'synthetic_admin')
        before,after=self.restarted()
        for row in [before,after]:row['actors'][1]['static']['owner']='fcd-support-synthetic-prior'
        with self.assertRaises(RuntimeError):action.qualify_prior_loss(before,after,'synthetic_admin')

    def test_two_restart_candidates_are_refused(self):
        before,after=self.restarted()
        for snapshot in [before,after]:
            other=copy.deepcopy(snapshot['actors'][1]);other['id']='synthetic_second';other['static']['name']='/synthetic_second';snapshot['actors'].append(other)
        with self.assertRaises(RuntimeError):action.qualify_prior_loss(before,after,'synthetic_admin')

    def test_inherited_qualification_must_match_original_fingerprint_exactly(self):
        fingerprint=[1,2,3,'a'*64]
        record={'missing':['b'*64],'originalBaseline':fingerprint}
        self.assertTrue(action.prior_qualification_valid(record,fingerprint))
        for changed in [{**record,'missing':[]},{**record,'missing':['b'*64,'c'*64]},{**record,'missing':['synthetic_invalid']},{**record,'originalBaseline':[1,2,4,'a'*64]},{**record,'extra':'synthetic'},None]:
            with self.subTest(changed=changed): self.assertFalse(action.prior_qualification_valid(changed,fingerprint))

if __name__=='__main__':unittest.main()
