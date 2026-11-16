"""Authored admission controls for the first private administrator."""
import importlib.util
from pathlib import Path
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('admin_setup',Path(__file__).with_name('2026-11-16-private-v1-admin.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def actor():
    return {'id':'a'*64,'project':m.PROJECT,'name':m.PROJECT+'-fcd-support-admin-1',
            'revision':m.REVISION,'user':'1000:1000','readonly':True,'ports':{},'running':True,'health':'healthy',
            'flags':['MODEL_EXECUTION_ENABLED=false','OUTBOUND_EXECUTION_ENABLED=false','N8N_EXECUTION_ENABLED=false']}


class AdminSetupTests(unittest.TestCase):
    def test_accepts_only_healthy_private_admin_after_completed_deployment(self):
        self.assertEqual(m.select_admin({'phase':'complete','revision':m.REVISION},[actor()]),'a'*64)

    def test_wrong_revision_unhealthy_exposed_or_enabled_admin_refuses(self):
        for field,value in [('revision','b'*40),('health','unhealthy'),('running',False),('readonly',False),
                            ('ports',{'80/tcp':[{}]}),('flags',['MODEL_EXECUTION_ENABLED=true'])]:
            row=actor();row[field]=value
            with self.assertRaises(m.Refusal):m.select_admin({'phase':'complete','revision':m.REVISION},[row])

    def test_incomplete_or_multiple_admins_refuse(self):
        for rows in [[],[actor(),actor()]]:
            with self.assertRaises(m.Refusal):m.select_admin({'phase':'complete','revision':m.REVISION},rows)
        with self.assertRaises(m.Refusal):m.select_admin({'phase':'uncertain','revision':m.REVISION},[actor()])

    def test_private_writer_uses_private_exclusive_lf_files(self):
        with TemporaryDirectory() as directory, patch.object(m.os,'O_NOFOLLOW',0,create=True):
            target=Path(directory)/'synthetic-private.json'
            m.private_file(target,'synthetic_first\nsynthetic_second\n')
            self.assertEqual(target.read_bytes(),b'synthetic_first\nsynthetic_second\n')
            with self.assertRaises(FileExistsError):m.private_file(target,'synthetic_replacement')

    def test_foreign_actor_cannot_be_selected(self):
        row=actor();row['project']='synthetic_foreign'
        with self.assertRaises(m.Refusal):m.select_admin({'phase':'complete','revision':m.REVISION},[row])


if __name__=='__main__':unittest.main()
