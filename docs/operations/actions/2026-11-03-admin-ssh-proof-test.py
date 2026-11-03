import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('proof',Path(__file__).with_name('2026-11-03-admin-ssh-proof.py'))
proof=importlib.util.module_from_spec(spec);spec.loader.exec_module(proof)

class Connection:
    def __init__(self):
        self.sent=[];self.closed=False
        self.sock=SimpleNamespace(getsockname=lambda:('127.0.0.1',15001))
    def connect(self): pass
    def request(self,*args): self.sent.append(args)
    def getresponse(self): return SimpleNamespace(status=200,read=lambda limit:b'',getheader=lambda key:None,getheaders=lambda:[])
    def close(self): self.closed=True

class ForwardOwnershipTests(unittest.TestCase):
    def test_wrong_owner_receives_no_http_request_or_credentials(self):
        connection=Connection()
        with mock.patch.object(proof.http.client,'HTTPConnection',return_value=connection), mock.patch.object(proof.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='999\n')), mock.patch.object(proof.os,'name','nt'):
            with self.assertRaises(RuntimeError):
                proof.request('POST','/login',{'password':'synthetic_nonfunctional'},owner_pid=123)
        self.assertEqual(connection.sent,[])
        self.assertTrue(connection.closed)

    def test_verified_established_peer_allows_http_request(self):
        connection=Connection()
        with mock.patch.object(proof.http.client,'HTTPConnection',return_value=connection), mock.patch.object(proof.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='123\n')), mock.patch.object(proof.os,'name','nt'):
            self.assertEqual(proof.request('GET','/login',owner_pid=123)[0],200)
        self.assertEqual(len(connection.sent),1)
        self.assertTrue(connection.closed)

    def test_missing_or_multiple_owner_results_refuse_before_http(self):
        for output in ['', '123\n123\n']:
            connection=Connection()
            with self.subTest(output=output), mock.patch.object(proof.http.client,'HTTPConnection',return_value=connection), mock.patch.object(proof.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=output)), mock.patch.object(proof.os,'name','nt'):
                with self.assertRaises(RuntimeError): proof.request('GET','/login',owner_pid=123)
            self.assertEqual(connection.sent,[])

if __name__=='__main__': unittest.main()
