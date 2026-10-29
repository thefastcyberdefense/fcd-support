"""Authored synthetic parser/record tests; no Docker, server or provider calls."""
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

OBSERVER_SOURCE = Path(__file__).with_name('2026-10-29-promotion-observer.py').read_text()
spec = importlib.util.spec_from_file_location(
    'promotion_observer', Path(__file__).with_name('2026-10-29-promotion-observer.py'))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)

REFERENCE = 'operation_' + 'b' * 32
REVISION = 'a' * 40
PROJECT = 'fcd-support-host-test-p6-' + 'a' * 7
ACTOR = 'c' * 64
COMMAND = 'd' * 64


def challenge(sequence=1, reference=REFERENCE, nonce='e' * 32):
    return json.dumps({'event': 'promotion_host_check', 'operationRef': reference,
                       'sequence': sequence, 'challenge': nonce}).encode()


def event():
    return {'Type': 'container', 'Action': 'start', 'Actor': {'ID': ACTOR, 'Attributes': {
        'fcd-support.operation.parent': PROJECT,
        'fcd-support.operation.service': 'promote',
        'org.opencontainers.image.revision': REVISION,
        'fcd-support.operation.ref': REFERENCE,
        'fcd-support.operation.command': COMMAND,
    }}}


def job():
    return {'JOB_VERSION': '1', 'JOB_PARENT': PROJECT,
            'JOB_PHASE': 'started', 'JOB_SERVICE': 'promote', 'JOB_REVISION': REVISION,
            'JOB_REF': REFERENCE, 'JOB_CONTAINER': ACTOR, 'JOB_IMAGE': 'sha256:' + 'f' * 64,
            'JOB_COMMAND_SHA256': COMMAND}


def projection():
    return [ACTOR, job()['JOB_IMAGE'], REFERENCE, PROJECT, 'promote', COMMAND, REVISION]


# This child runs the actual observe loop, with only its Docker/OS ports faked.
# No Docker command, server path, UID change or real reader process is invoked.
WORKER = r'''
import json, os, signal, subprocess, sys, types
from pathlib import Path
module=types.ModuleType('promotion_observer')
exec(sys.stdin.read(),module.__dict__)
mode,folder=sys.argv[1:]; folder=Path(folder)
module.ROOT=folder/'fixture'; module.OUTPUT=folder/'records.jsonl'
module.PROJECT='fcd-support-host-test-p6-'+'a'*7; module.REVISION='a'*40
module.sys.platform='linux'; module.os.getuid=lambda:1000; module.os.getgid=lambda:1000
if not hasattr(module.os,'O_NOFOLLOW'): module.os.O_NOFOLLOW=0
module.protected_directory=lambda path:None
actor='c'*64; reference='operation_'+'b'*32; command='d'*64; image='sha256:'+'f'*64
job={'JOB_VERSION':'1','JOB_PARENT':module.PROJECT,'JOB_PHASE':'started','JOB_SERVICE':'promote',
     'JOB_REVISION':module.REVISION,'JOB_REF':reference,'JOB_CONTAINER':actor,
     'JOB_IMAGE':image,'JOB_COMMAND_SHA256':command}
module.read_job=lambda:(job,(1,2,100,3,4))
projection=[actor,image,reference,module.PROJECT,'promote',command,module.REVISION]
if mode=='guard-refusal':
 projection[1]='sha256:'+'0'*64
module.subprocess.run=lambda *args,**kwargs:types.SimpleNamespace(returncode=0,stdout=json.dumps(projection).encode())
clock=[0.0]; module.time.monotonic=lambda:clock[0]
readers=[]; delivered=[False]; pending={}; counter=[0]
attributes={'fcd-support.operation.parent':module.PROJECT,'fcd-support.operation.service':'promote',
 'org.opencontainers.image.revision':module.REVISION,'fcd-support.operation.ref':reference,
 'fcd-support.operation.command':command}
def lifecycle(action):
 attrs=dict(attributes)
 if action=='die': attrs['exitCode']='0'
 return json.dumps({'Type':'container','Action':action,'Actor':{'ID':actor,'Attributes':attrs}}).encode()+b'\n'
def protocol(sequence,nonce):
 return json.dumps({'event':'promotion_host_check','operationRef':reference,'sequence':sequence,'challenge':nonce}).encode()+b'\n'
class Stream:
 def __init__(self,number): self.number=number; self.closed=False
 def fileno(self): return self.number
 def close(self): self.closed=True
class Reader:
 def __init__(self,args):
  self.args=args; self.stdout=Stream(100+len(readers)); self.terminated=False; self.killed=False; self.waits=[]
 def poll(self): return 1 if mode=='early-exit' else None
 def terminate(self): self.terminated=True
 def kill(self): self.killed=True
 def wait(self,timeout):
  self.waits.append(timeout)
  if mode=='kill-fallback' and not self.killed: raise subprocess.TimeoutExpired('synthetic_reader',timeout)
  return 0
def launch(args,**kwargs):
 if mode=='partial-launch' and 'logs' in args: raise OSError('synthetic_sensitive_sentinel')
 value=Reader(args); readers.append(value); return value
module.subprocess.Popen=launch; module.os.set_blocking=lambda *args:None
class Selector:
 def __init__(self): self.keys={}; self.closed=False
 def register(self,fileobj,events,kind): self.keys[kind]=types.SimpleNamespace(fileobj=fileobj,data=kind)
 def unregister(self,fileobj):
  self.keys={kind:key for kind,key in self.keys.items() if key.fileobj is not fileobj}
 def close(self): self.closed=True
 def select(self,timeout):
  step=counter[0]; counter[0]+=1
  if mode in ('interrupt','hangup'):
   delivered[0]=True; signal.raise_signal(signal.SIGTERM if mode=='interrupt' else signal.SIGHUP)
   return []
  if mode in ('timeout','kill-fallback'): clock[0]=11.0; return []
  kind='events' if step in (0,2) else 'logs'
  if mode=='eof': kind='events'; data=b''
  elif mode=='fragmented':
   if step==0: kind='events'; data=lifecycle('start').replace(b'\n',b'\r\n')[:15]
   elif step==1: kind='events'; data=lifecycle('start').replace(b'\n',b'\r\n')[15:]
   elif step==2: kind='logs'; data=(protocol(1,'e'*32).replace(b'\n',b'\r\n'))[:20]
   elif step==3: kind='logs'; data=(protocol(1,'e'*32).replace(b'\n',b'\r\n'))[20:]+(protocol(2,'f'*32)+b'{"status":"completed","processed":1,"reasonCode":"ok"}\r\n')
   elif step==4: kind='events'; data=(lifecycle('die')+lifecycle('destroy')).replace(b'\n',b'\r\n')
   elif step==5: kind='logs'; data=b''
   else: clock[0]=2.0; return []
  elif step==0: data=lifecycle('start')
  elif step==1: data=protocol(1,'e'*32)+protocol(2,'f'*32)+b'{"status":"completed","processed":1,"reasonCode":"ok"}\n'
  elif step==2: data=lifecycle('die')+lifecycle('destroy')
  elif step==3: data=b''
  else: clock[0]=2.0; return []
  key=self.keys[kind]; pending[key.fileobj.fileno()]=data; return [(key,1)]
selector=Selector(); module.selectors.DefaultSelector=lambda:selector
module.os.read=lambda descriptor,size:pending.pop(descriptor)
result=module.observe(10)
stages=[json.loads(line)['stage'] for line in module.OUTPUT.read_text().splitlines()]
raw=module.OUTPUT.read_text()
print(json.dumps({'result':result,'delivered':delivered[0],'stages':stages,'selectorClosed':selector.closed,
 'readers':[{'terminated':p.terminated,'killed':p.killed,'closed':p.stdout.closed,'waits':p.waits,
             'bounded':'--until' in p.args} for p in readers],
 'contentFree':not any(value in raw for value in [actor,reference,command,'e'*32,'f'*32,'synthetic_sensitive_sentinel'])}))
'''


class ObserverTests(unittest.TestCase):
    def runtime(self, mode):
        with tempfile.TemporaryDirectory(prefix='fcd-support-observer-test-') as folder:
            self.assertEqual(Path(folder).resolve().parent, Path(tempfile.gettempdir()).resolve())
            result = subprocess.run([sys.executable, '-B', '-c', WORKER, mode, folder],
                                    input=OBSERVER_SOURCE, capture_output=True, text=True,
                                    encoding='utf-8', timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout.splitlines()[-1])
            self.assertTrue(value['selectorClosed'])
            self.assertTrue(value['contentFree'])
            self.assertTrue(all(reader['closed'] for reader in value['readers']))
            return value

    def test_runtime_complete_protocol_and_lifecycle(self):
        value = self.runtime('complete')
        self.assertEqual(value['result'], 0)
        self.assertEqual(len(value['readers']), 2)
        for stage in ['challenge_1', 'challenge_2', 'command_completed', 'container_die',
                      'container_destroy', 'observer_finished']:
            self.assertIn(stage, value['stages'])

    def test_runtime_timeout_and_reader_eof_reap_readers(self):
        for mode in ['timeout', 'eof']:
            value = self.runtime(mode)
            self.assertEqual(value['result'], 2)
            self.assertTrue(all(reader['terminated'] for reader in value['readers']))

    def test_runtime_partial_launch_reaps_already_started_reader(self):
        value = self.runtime('partial-launch')
        self.assertEqual(value['result'], 1)
        self.assertEqual(len(value['readers']), 1)
        self.assertTrue(value['readers'][0]['terminated'])
        self.assertIn('guard_refused', value['stages'])

    def test_runtime_sigterm_exits_through_cleanup(self):
        value = self.runtime('interrupt')
        self.assertEqual(value['result'], 2)
        self.assertTrue(value['delivered'])
        self.assertTrue(all(reader['terminated'] for reader in value['readers']))

    @unittest.skipUnless(hasattr(signal, 'SIGHUP'), 'Linux SIGHUP case')
    def test_runtime_sighup_exits_through_cleanup(self):
        value = self.runtime('hangup')
        self.assertEqual(value['result'], 2)
        self.assertTrue(all(reader['terminated'] for reader in value['readers']))

    def test_runtime_bounded_kill_fallback(self):
        value = self.runtime('kill-fallback')
        self.assertEqual(value['result'], 2)
        self.assertTrue(value['readers'][0]['killed'])
        self.assertEqual(value['readers'][0]['waits'], [2, 2])

    def test_runtime_reader_commands_have_independent_deadlines(self):
        value = self.runtime('complete')
        self.assertTrue(all(reader['bounded'] for reader in value['readers']))

    def test_runtime_early_reader_exit_is_incomplete(self):
        value = self.runtime('early-exit')
        self.assertEqual(value['result'], 1)
        self.assertNotIn('observer_ready', value['stages'])

    def test_runtime_fragmented_crlf_stream(self):
        value = self.runtime('fragmented')
        self.assertEqual(value['result'], 0)
        self.assertEqual(len(value['readers']), 2)
        for stage in ['challenge_1', 'challenge_2', 'command_completed', 'container_die',
                      'container_destroy', 'observer_finished']:
            self.assertIn(stage, value['stages'])

    def test_runtime_guard_refusal_reaps_reader(self):
        value = self.runtime('guard-refusal')
        self.assertEqual(value['result'], 1)
        self.assertEqual(len(value['readers']), 1)
        self.assertTrue(value['readers'][0]['terminated'])
        self.assertIn('guard_refused', value['stages'])

    def test_two_fresh_protocol_challenges(self):
        one = observer.protocol_stage(challenge(), REFERENCE)
        self.assertEqual(one, ('challenge_1', 2, 'e' * 32))
        self.assertEqual(observer.protocol_stage(challenge(2, nonce='f' * 32), REFERENCE, *one[1:]),
                         ('challenge_2', 3, 'f' * 32))

    def test_duplicate_challenge_nonces_rejected(self):
        one = observer.protocol_stage(challenge(), REFERENCE)
        self.assertEqual(one[0], 'challenge_1')
        duplicate = observer.protocol_stage(challenge(2, nonce='e' * 32), REFERENCE, *one[1:])
        self.assertEqual(duplicate[0], 'protocol_invalid')

    def test_replayed_or_out_of_order_challenge(self):
        self.assertEqual(observer.protocol_stage(challenge(2), REFERENCE)[0], 'protocol_invalid')
        self.assertEqual(observer.protocol_stage(challenge(2), REFERENCE, 2, 'e' * 32)[0], 'protocol_invalid')

    def test_wrong_reference(self):
        self.assertEqual(observer.protocol_stage(challenge(reference='operation_' + 'f' * 32), REFERENCE)[0],
                         'protocol_invalid')

    def test_extra_or_wrong_shape(self):
        frame = json.loads(challenge()); frame['unexpected'] = 'synthetic_sensitive_sentinel'
        self.assertEqual(observer.protocol_stage(json.dumps(frame).encode(), REFERENCE)[0], 'protocol_invalid')
        frame = json.loads(challenge()); frame['sequence'] = True
        self.assertEqual(observer.protocol_stage(json.dumps(frame).encode(), REFERENCE)[0], 'protocol_invalid')

    def test_completion_requires_both_challenges(self):
        frame = b'{"status":"completed","processed":1,"reasonCode":"ok"}'
        self.assertEqual(observer.protocol_stage(frame, REFERENCE)[0], 'protocol_invalid')
        self.assertEqual(observer.protocol_stage(frame, REFERENCE, 3, 'f' * 32)[0], 'command_completed')

    def test_completion_requires_an_integer_count(self):
        self.assertEqual(observer.protocol_stage(
            b'{"status":"completed","processed":true,"reasonCode":"ok"}', REFERENCE, 3)[0],
            'protocol_invalid')

    def test_duplicate_json_keys_are_discarded(self):
        frame = b'{"status":"completed","processed":1,"processed":0,"reasonCode":"ok"}'
        self.assertEqual(observer.protocol_stage(frame, REFERENCE, 3)[0], 'unexpected_output')

    def test_closed_failure_is_not_sql_outcome(self):
        self.assertEqual(observer.protocol_stage(b'promotion_command_failed', REFERENCE)[0], 'command_refused')

    def test_arbitrary_and_invalid_utf8_never_enter_records(self):
        for frame in [b'synthetic_sensitive_sentinel', b'\xff', b'{', b'[]']:
            stage = observer.protocol_stage(frame, REFERENCE)[0]
            self.assertEqual(stage, 'unexpected_output')
            record = json.dumps(observer.closed_record(stage, 1))
            self.assertNotIn('synthetic_sensitive_sentinel', record)
            self.assertNotIn(REFERENCE, record)

    def test_owned_event_is_bound_without_emitting_labels(self):
        self.assertEqual(observer.event_identity(event(), PROJECT, REVISION),
                         (ACTOR, REFERENCE, COMMAND))

    def test_foreign_events_are_ignored(self):
        for key, value in [('fcd-support.operation.parent', 'fcd-support-synthetic-other'),
                           ('fcd-support.operation.service', 'backup'),
                           ('org.opencontainers.image.revision', 'f' * 40),
                           ('fcd-support.operation.ref', 'invalid'),
                           ('fcd-support.operation.command', 'invalid')]:
            frame = event(); frame['Actor']['Attributes'][key] = value
            self.assertIsNone(observer.event_identity(frame, PROJECT, REVISION))

    def test_malformed_actor_is_ignored(self):
        for frame in [None, [], {}, {'Type': 'image'}, {'Type': 'container', 'Actor': []}]:
            self.assertIsNone(observer.event_identity(frame, PROJECT, REVISION))

    def test_fragmented_frames_and_crlf(self):
        frames, buffer = observer.split_frames(b'', b'one\r\ntw', 8)
        self.assertEqual((frames, buffer), ([b'one'], b'tw'))
        self.assertEqual(observer.split_frames(buffer, b'o\n', 8), ([b'two'], b''))

    def test_bounded_frames_and_chunks(self):
        for buffer, chunk, maximum in [(b'1234', b'56789', 8), (b'', b'123456789\n', 8),
                                       (b'', b'x' * 65537, 16384)]:
            with self.assertRaisesRegex(ValueError, '^observer_output_limit$'):
                observer.split_frames(buffer, chunk, maximum)

    def test_records_allow_only_fixed_fields(self):
        self.assertEqual(observer.closed_record('container_die', 123, 137),
                         {'stage': 'container_die', 'elapsedMs': 123, 'exitCode': 137})
        self.assertEqual(observer.closed_record('challenge_1', 1), {'stage': 'challenge_1', 'elapsedMs': 1})

    def test_records_reject_unbounded_or_arbitrary_material(self):
        for args in [('synthetic_sensitive_sentinel', 1), ('challenge_1', -1),
                     ('challenge_1', True), ('challenge_1', 300001),
                     ('container_die', 1, 256), ('container_die', 1, True), ('challenge_1', 1, 0)]:
            with self.assertRaisesRegex(ValueError, '^observer_record_invalid$'):
                observer.closed_record(*args)

    def test_job_binding_checks_every_projected_field(self):
        identity = (ACTOR, REFERENCE, COMMAND)
        self.assertTrue(observer.bind_job(identity, job(), projection(), PROJECT, REVISION))
        for index in range(7):
            changed = projection(); changed[index] = 'synthetic_substitution'
            self.assertFalse(observer.bind_job(identity, job(), changed, PROJECT, REVISION))

    def test_job_binding_rejects_missing_or_wrong_journal(self):
        for value in [None, {}, {**job(), 'JOB_PHASE': 'created'},
                      {**job(), 'JOB_VERSION': '2'}, {**job(), 'JOB_PARENT': 'fcd-support-synthetic-other'},
                      {**job(), 'JOB_REF': 'operation_' + 'e' * 32},
                      {**job(), 'JOB_SERVICE': 'backup'}, {**job(), 'JOB_REVISION': 'e' * 40}]:
            self.assertFalse(observer.bind_job((ACTOR, REFERENCE, COMMAND), value,
                                               projection(), PROJECT, REVISION))

    def test_bind_job_rejects_missing_actor_and_boolean_types(self):
        self.assertFalse(observer.bind_job(('', REFERENCE, COMMAND), job(), projection(), PROJECT, REVISION))
        self.assertFalse(observer.bind_job((ACTOR, REFERENCE, COMMAND), {**job(), 'JOB_VERSION': True}, projection(), PROJECT, REVISION))
        self.assertFalse(observer.bind_job((ACTOR, REFERENCE, COMMAND), {**job(), 'JOB_PHASE': 'completed'}, projection(), PROJECT, REVISION))

    def test_follow_starts_only_after_actual_identity_and_journal_match(self):
        calls = []
        def launch(actor):
            calls.append(actor); return 'synthetic_reader'
        with self.assertRaisesRegex(ValueError, '^observer_guard_refused$'):
            observer.attach_logs((ACTOR, REFERENCE, COMMAND), PROJECT, REVISION,
                                 lambda: (job(), (1, 2, 100, 3, 4)), lambda actor: [], launch)
        self.assertEqual(calls, [])
        self.assertEqual(observer.attach_logs((ACTOR, REFERENCE, COMMAND), PROJECT, REVISION,
                         lambda: (job(), (1, 2, 100, 3, 4)), lambda actor: projection(), launch), 'synthetic_reader')
        self.assertEqual(calls, [ACTOR])

    def test_replaced_journal_never_starts_log_follow(self):
        observations = iter([(job(), (1, 2, 100, 3, 4)), (job(), (1, 9, 100, 3, 4))])
        calls = []
        with self.assertRaisesRegex(ValueError, '^observer_guard_refused$'):
            observer.attach_logs((ACTOR, REFERENCE, COMMAND), PROJECT, REVISION,
                                 lambda: next(observations), lambda actor: projection(), calls.append)
        self.assertEqual(calls, [])

    def test_docker_port_refuses_mutating_subcommands(self):
        for args in [['start', ACTOR], ['container', 'stop', ACTOR], ['container', 'rm', ACTOR],
                     ['exec', ACTOR, 'true'], ['compose', 'up'], ['network', 'connect', 'synthetic']]:
            with self.assertRaisesRegex(ValueError, '^observer_command_refused$'):
                observer.docker_arguments(args)
        for args in [['events', '--format', '{{json .}}'], ['container', 'inspect', ACTOR],
                     ['container', 'logs', '--follow', ACTOR]]:
            self.assertEqual(observer.docker_arguments(args),
                             ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args])


if __name__ == '__main__':
    unittest.main()
