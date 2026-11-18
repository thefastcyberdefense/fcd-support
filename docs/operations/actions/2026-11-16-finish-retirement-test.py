"""Authored controls for the exact legacy-only retirement completion."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('finish_retirement',Path(__file__).with_name('2026-11-16-finish-retirement.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def fixture():
    actors=[{'id':str(i)*64,'name':name,'image':'synthetic_image','mounts':[],'networks':{},'project':'fcd-support','synthetic':''}
            for i,name in enumerate(sorted(m.LEGACY),1)]
    actors += [{'id':str(i)*64,'name':name,'image':'synthetic_image','mounts':[],'networks':{},'project':'synthetic_private','synthetic':''} for i,name in enumerate(sorted(m.ORIGINAL-m.LEGACY),4)]
    removed=actors[3:]
    record={'phase':'uncertain','plan':{'actors':actors,'protected_actor_ids':['a'*64]},
            'completed':[{'kind':'container','action':action,'target':r['id']} for r in removed for action in ['stop','rm']]}
    state={'actors':copy.deepcopy(actors[:3])+[{'id':'a'*64,'name':'synthetic_foreign'}]}
    return record,state


class FinishTests(unittest.TestCase):
    def test_accepts_only_the_exact_original_three_legacy_identities(self):
        record,state=fixture();self.assertEqual(m.admit(record,state),{r['id'] for r in state['actors'][:3]})

    def test_missing_removal_ack_or_changed_identity_refuses(self):
        for change in ['ack','identity','protected']:
            record,state=fixture()
            if change=='ack':record['completed'].pop()
            elif change=='identity':state['actors'][0]['id']='b'*64
            else:state['actors'][-1]['id']='c'*64
            with self.assertRaises(m.Refusal):m.admit(record,state)

    def test_changed_legacy_mount_or_previously_complete_marker_refuses(self):
        record,state=fixture();state=copy.deepcopy(state);state['actors'][0]['mounts']=[{'Type':'bind','Source':'/synthetic_foreign'}]
        with self.assertRaises(m.Refusal):m.admit(record,state)
        record,state=fixture();record['phase']='complete'
        with self.assertRaises(m.Refusal):m.admit(record,state)

    def test_only_admitted_container_stop_gets_the_bounded_timeout(self):
        class FakeParent:
            def docker(self,*args):return args
        self.assertEqual(m.bounded_stop_args(['container','stop','--time','-1','1'*64],{'1'*64}),
                         ['container','stop','--time','30','1'*64])
        with self.assertRaises(m.Refusal):m.bounded_stop_args(['container','stop','--time','-1','2'*64],{'1'*64})
        self.assertEqual(m.bounded_stop_args(['volume','rm','synthetic_volume'],{'1'*64}),['volume','rm','synthetic_volume'])


if __name__=='__main__':unittest.main()
