"""Authored scope/refusal fixtures; never invokes Docker or the cleanup entrypoint."""
import copy
import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).with_name('2026-11-03-retire-old-tests.py')
module=None
if path.exists():
    spec=importlib.util.spec_from_file_location('retire_tests',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(module)
        self.latest='fcd-support-host-test-synthetic-current'
        self.old='fcd-support-host-test-synthetic-old'
        self.row={'id':'a'*64,'name':self.old+'-fcd-support-api-1','project':self.old,
                  'synthetic':self.old,'parent':None,'service':'fcd-support-api','autoRemove':False,
                  'flags':['MODEL_EXECUTION_ENABLED=false','OUTBOUND_EXECUTION_ENABLED=false','N8N_EXECUTION_ENABLED=false']}

    def select(self,rows): return module.select_targets(rows,self.latest,{self.old:1})

    def test_only_exact_old_scope_is_selected(self):
        latest={**self.row,'id':'b'*64,'name':self.latest+'-fcd-support-api-1','project':self.latest,'synthetic':self.latest}
        connected={**self.row,'id':'c'*64,'name':'fcd-support-fcd-support-api-1','project':'fcd-support','synthetic':None}
        other={**self.row,'id':'d'*64,'name':'synthetic_other','project':'synthetic_other','synthetic':None}
        self.assertEqual(self.select([self.row,latest,connected,other]),[self.row])

    def test_latest_label_conflict_or_old_operation_owner_refuses(self):
        for field,value in [('synthetic',self.latest),('parent',self.latest),('parent',self.old)]:
            with self.subTest(field=field,value=value),self.assertRaises(RuntimeError):self.select([{**self.row,field:value}])

    def test_wrong_name_count_duplicate_or_enabled_execution_refuses(self):
        for rows in [[{**self.row,'name':'synthetic_foreign'}],[],[self.row,self.row],
                     [{**self.row,'flags':['MODEL_EXECUTION_ENABLED=true']}], [{**self.row,'autoRemove':True}]]:
            with self.subTest(count=len(rows)),self.assertRaises(RuntimeError):self.select(rows)

    def test_old_peer_requires_exact_synthetic_name_and_no_compose_owner(self):
        peer={**self.row,'name':self.old+'-ingress-peer','project':None,'service':None,'flags':[]}
        self.assertEqual(self.select([peer]),[peer])
        with self.assertRaises(RuntimeError):self.select([{**peer,'project':'synthetic_foreign'}])

    def test_only_authorized_actor_and_network_members_are_projected_out(self):
        before={'actors':[self.row,{'id':'synthetic_kept'}], 'networks':[{'members':{'a'*64:{'Name':'synthetic_old'},'synthetic_kept':{'Name':'synthetic_kept'}}}], 'volumes':['synthetic_volume'],'files':{'synthetic_state':'synthetic_hash'}}
        saved=copy.deepcopy(before)
        actual=module.protected_projection(before,{'a'*64})
        self.assertEqual(actual,{'actors':[{'id':'synthetic_kept'}],'networks':[{'members':{'synthetic_kept':{'Name':'synthetic_kept'}}}],'volumes':['synthetic_volume'],'files':{'synthetic_state':'synthetic_hash'}})
        self.assertEqual(before,saved)

    def test_removal_uses_only_unforced_container_id_without_volume_flags(self):
        calls=[]
        module.remove_container(lambda args: calls.append(args) or 'a'*64,'a'*64)
        self.assertEqual(calls,[['docker','rm','a'*64]])
        with self.assertRaises(RuntimeError):module.remove_container(lambda args:'','--volumes')

    def test_stop_never_arms_a_daemon_sigkill_deadline(self):
        self.assertTrue(callable(getattr(module,'stop_container',None)))
        calls=[]
        def command(args,timeout):calls.append((args,timeout));return 'a'*64
        module.stop_container(command,'a'*64)
        self.assertEqual(calls,[(['docker','stop','--time','-1','a'*64],80)])


if __name__=='__main__':unittest.main()
