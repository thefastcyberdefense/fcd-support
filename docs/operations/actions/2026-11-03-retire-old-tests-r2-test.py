"""Synthetic continuation/CLI compatibility guards, no Docker invocation."""
import copy
import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).with_name('2026-11-03-retire-old-tests-r2.py');module=None
if path.exists():
 spec=importlib.util.spec_from_file_location('retirement_r2',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class ContinuationTests(unittest.TestCase):
 def setUp(self):self.assertIsNotNone(module)

 def test_only_indefinite_stop_uses_canonical_option(self):
  self.assertEqual(module.canonical_arguments(['docker','stop','--time','-1','a'*64]),['docker','stop','--timeout','-1','a'*64])
  for args in [['docker','stop','--time','60','a'*64],['docker','stop','--force','a'*64],['docker','stop','--time','-1','--volumes']]:
   with self.subTest(args=args),self.assertRaises(RuntimeError):module.canonical_arguments(args)
  self.assertEqual(module.canonical_arguments(['docker','rm','a'*64]),['docker','rm','a'*64])

 def test_clean_stop_can_continue_without_repeating_it(self):
  before={'actors':[{'id':'synthetic_old','image':'synthetic_image','state':'running'}, {'id':'synthetic_kept','image':'synthetic_kept','state':'running'}],'networks':[]}
  current=copy.deepcopy(before);current['actors'][0]['state']='exited'
  module.verify_continuation(before,[before['actors'][0]],current,self.project,self.identity)

 def test_changed_target_or_survivor_or_absent_actor_refuses(self):
  before={'actors':[{'id':'synthetic_old','image':'synthetic_image','state':'running'}, {'id':'synthetic_kept','image':'synthetic_kept','state':'running'}],'networks':[]}
  for kind in ['target','survivor','absent']:
   changed=copy.deepcopy(before)
   if kind=='target':changed['actors'][0]['image']='synthetic_changed'
   elif kind=='survivor':changed['actors'][1]['image']='synthetic_changed'
   else:changed['actors'].pop(0)
   with self.subTest(kind=kind),self.assertRaises(RuntimeError):module.verify_continuation(before,[before['actors'][0]],changed,self.project,self.identity)

 def test_non_exited_or_running_target_refuses(self):
  before={'actors':[{'id':'synthetic_old','image':'synthetic_image','state':'running'}],'networks':[]}
  changed=copy.deepcopy(before);changed['actors'][0]['state']='dead'
  with self.assertRaises(RuntimeError):module.verify_continuation(before,before['actors'],changed,self.project,self.identity)

 @staticmethod
 def identity(row):return {k:v for k,v in row.items() if k!='state'}

 @staticmethod
 def project(data,ids):
  result=copy.deepcopy(data);result['actors']=[row for row in result['actors'] if row['id'] not in ids];return result


if __name__=='__main__':unittest.main()
