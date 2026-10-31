"""Authored quarantine-admission cases; no SSH or Docker calls."""
import copy
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('current_runtime_recovery', Path(__file__).with_name('2026-10-31-current-runtime-recovery-67a4a4b.py'))
module = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'fcntl': types.ModuleType('fcntl')}): spec.loader.exec_module(module)


def fixture():
    before = {'files': {'synthetic-state': 'same'}, 'volumes': ['synthetic-volume'], 'actors': [
        {'id': 'synthetic-running', 'state': 'running', 'started': 'synthetic-before', 'image': 'synthetic-image', 'networks': {'bridge': {'NetworkID': 'synthetic-bridge-before'}, 'synthetic-private': {'NetworkID': 'synthetic-network'}}, 'mounts': []},
        *[{'id': 'synthetic-stopped-' + str(i), 'state': 'exited', 'started': 'synthetic-before', 'image': 'synthetic-image', 'networks': {}, 'mounts': []} for i in range(7)]],
        'networks': [{'id': 'synthetic-network', 'name': 'synthetic-private', 'created': 'synthetic-before', 'driver': 'bridge', 'internal': True, 'ipam': {}, 'options': {}, 'labels': {}, 'members': {}}, {'id': 'synthetic-bridge-before', 'name': 'bridge', 'created': 'synthetic-before', 'members': {}}]}
    after = copy.deepcopy(before); after['actors'] = after['actors'][:1]; after['actors'][0]['started'] = 'synthetic-after'
    after['actors'][0]['networks']['bridge']['NetworkID'] = 'synthetic-bridge-after'
    after['networks'][1].update(id='synthetic-bridge-after', created='synthetic-after')
    return before, after


class QuarantineAdmissionTests(unittest.TestCase):
    def test_only_the_observed_seven_previously_stopped_absences_are_recorded(self):
        before, after = fixture(); self.assertEqual(module.post_restart_quarantine(before, after), ['synthetic-stopped-' + str(i) for i in range(7)])

    def test_no_replacement_running_actor_loss_state_or_volume_change_is_admitted(self):
        mutations = [
            lambda a: a['actors'].clear(),
            lambda a: a['actors'].append({'id': 'synthetic-foreign', 'state': 'running'}),
            lambda a: a['files'].update({'synthetic-new': 'changed'}),
            lambda a: a['volumes'].clear(),
            lambda a: a['actors'][0].update(image='synthetic-substitution'),
            lambda a: a['actors'][0]['mounts'].append({'synthetic': 'changed'}),
            lambda a: a['networks'][0].update(id='synthetic-substitution'),
            lambda a: a['actors'][0]['networks']['synthetic-private'].update(NetworkID='synthetic-other'),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                before, after = fixture(); mutate(after)
                with self.assertRaises(RuntimeError): module.post_restart_quarantine(before, after)
        before, after = fixture(); before['actors'][1]['state'] = 'running'
        with self.assertRaises(RuntimeError): module.post_restart_quarantine(before, after)


class CurrentRepairRunnerTests(unittest.TestCase):
    def exercise(self, fault=None, repeat=False):
        import contextlib,io,json,tempfile
        spec = importlib.util.spec_from_file_location('allocation_fixture',Path(__file__).with_name('2026-10-31-rollback-after-reboot-test.py'))
        fixture_module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules,{'fcntl':types.ModuleType('fcntl')}):spec.loader.exec_module(fixture_module)
        peer_before,peer_after=fixture_module.fixture()
        with tempfile.TemporaryDirectory(prefix='synthetic-current-repair-') as directory:
            current=Path(directory)/'current';calls=[];state={'admin':'restarting','peer':'exited'}
            record={'admin':{'synthetic':'admin-definition'},'socket':[1,2],'peerBefore':peer_before,'pins':{'synthetic':'boot'},'others':{'synthetic':'other-projects'}}
            def admin():
                value=state['admin'];return {'Id':'synthetic-current-admin','State':{'Status':value,'Running':value=='running','Restarting':value=='restarting','Health':{'Status':'healthy' if value=='running' else 'unhealthy'}}}
            def peer():
                value=state['peer'];return {'Id':'synthetic-current-peer','State':{'Status':value,'Running':value=='running','Restarting':False}}
            def preserve(value):
                if fault=='others-before':raise RuntimeError('synthetic-other-project-change')
                if fault in ['others-after','binding','pending'] and calls:raise RuntimeError('synthetic-preservation-refused')
            def definition(actor):
                return {'synthetic':'foreign'} if fault=='definition' and calls else record['admin']
            def pins():return {'synthetic':'changed'} if fault=='boot' and any(k=='start-admin' for k,_ in calls) else record['pins']
            def command(args,name,timeout=2400):
                if args[0]=='docker':
                    self.assertEqual(args[1],'container');self.assertIn(args[2],['stop','start']);self.assertIn(args[-1],['synthetic-current-admin','synthetic-current-peer'])
                    kind='stop-admin' if args[2]=='stop' else ('start-admin' if args[-1]=='synthetic-current-admin' else 'start-peer')
                else:
                    self.assertEqual(args[0],'bash');kind={'recover-admin-socket.sh':'recover','verify-runtime.sh':'verify'}[Path(args[1]).name]
                calls.append((kind,args))
                if fault==kind:raise RuntimeError('synthetic-command-refused')
                if kind=='stop-admin':state['admin']='exited'
                if kind=='start-admin':state['admin']='running'
                if kind=='start-peer':state['peer']='running'
                if kind=='recover':(current/name).write_bytes(b'synthetic_wrong_ack\n' if fault=='ack' else b'admin_socket_recovered\n')
            def write(name,value):
                with (current/name).open('xb') as output:output.write(value)
            changes={'CURRENT':current,'initial':lambda:record,'preserve':preserve,'fresh':lambda *a,**kw:None,'admin':admin,'definition':definition,'socket_probe':lambda:record['socket'],'peer':peer,'peer_definition':lambda actor:peer_after if state['peer']=='running' else peer_before,'pins':pins,'locked':lambda callback:callback(),'create_current':lambda:current.mkdir(),'write_current':write,'command':command,'protected':lambda path,*args:(Path(path).read_bytes(),[]),'config':lambda:{'FCD_STOP_GRACE_MS':'1000','FCD_READY_TIMEOUT_SECONDS':'1','FCD_ADMIN_SOCKET_ROOT':str(Path(directory)/'synthetic-socket')}}
            with contextlib.ExitStack() as stack:
                for key,value in changes.items():stack.enter_context(patch.object(module,key,value))
                stack.enter_context(patch.object(sys,'argv',['synthetic-current-repair','--execute']))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                if fault:
                    with self.assertRaises(RuntimeError):module.main()
                    self.assertFalse((current/'readiness-completed').exists())
                    if fault in ['others-before','others-after','binding','pending','definition','stop-admin','recover','ack']:self.assertNotIn('start-admin',[k for k,_ in calls])
                    if fault=='boot':self.assertNotIn('start-peer',[k for k,_ in calls])
                else:
                    module.main();self.assertEqual((current/'readiness-completed').read_bytes(),b'completed\n')
                    if repeat:
                        before=len(calls)
                        with self.assertRaises(FileExistsError):module.main()
                        self.assertEqual(len(calls),before)
            return calls

    def test_only_current_admin_and_same_inert_peer_are_touched_in_order(self):
        calls=self.exercise();self.assertEqual([kind for kind,_ in calls],['stop-admin','recover','start-admin','start-peer','verify'])
        self.assertEqual(calls[0][1][-1],calls[2][1][-1]);self.assertIn('--confirm-admin-stopped',calls[1][1])
        self.assertNotIn('rollback-runtime.sh',str(calls));self.assertNotIn('promote-restore.sh',str(calls));self.assertNotIn('prune',str(calls))

    def test_other_project_drift_ack_boot_and_command_failures_never_complete(self):
        for fault in ['others-before','others-after','binding','pending','definition','boot','stop-admin','recover','ack','start-admin','start-peer','verify']:
            with self.subTest(fault=fault):self.exercise(fault=fault)

    def test_new_recovery_namespace_is_single_use(self):self.exercise(repeat=True)


if __name__ == '__main__': unittest.main()
