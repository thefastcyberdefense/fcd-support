"""One-use completion after the recorded legacy API graceful-stop timeout."""
import collections
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

HOME=Path('/home/redwan')
ORIGINAL_RECORD=HOME/'fcd-support-retirement-20261116/retirement.json'
COMPLETION=HOME/'fcd-support-retirement-completion-20261116'
LEGACY={'fcd-support-fcd-support-api-1','fcd-support-postgres-1','fcd-support-cloudflared'}
ORIGINAL=LEGACY | {'fcd-support-host-test-p6-b1e183d-'+service+'-1' for service in ['fcd-support-api','fcd-support-admin','fcd-support-reply','postgres']}
ORIGINAL.add('fcd-support-host-test-p6-b1e183d-ingress-peer')


class Refusal(Exception):pass


def require(value):
    if not value:raise Refusal('retirement_completion_refused')


def admit(record,state):
    require(record['phase']=='uncertain')
    rows=record['plan']['actors'];require(len(rows)==8 and {r['name'] for r in rows}==ORIGINAL)
    original={r['id']:r for r in rows};require(len(original)==8)
    legacy={r['id']:r for r in rows if r['name'] in LEGACY};require(len(legacy)==3)
    removed=set(original)-set(legacy)
    expected=collections.Counter((ident,action) for ident in removed for action in ['stop','rm'])
    observed=collections.Counter()
    for action in record['completed']:
        require(action['kind']=='container' and action['action'] in ['stop','rm'])
        observed[(action['target'],action['action'])]+=1
    require(observed==expected)
    present={r['id']:r for r in state['actors']};require(len(present)==len(state['actors']))
    require(set(present)==set(legacy)|set(record['plan']['protected_actor_ids']))
    for ident,row in legacy.items():require(present[ident]==row)
    return set(legacy)


def bounded_stop_args(args,allowed):
    if args[:2]==['container','stop']:
        require(len(args)==5 and args[2:4]==['--time','-1'] and args[-1] in allowed)
        return ['container','stop','--time','30',args[-1]]
    return args


def main(args):
    try:
        require(args in [['--inspect'],['--finish-approved-legacy-retirement']])
        require(sys.platform=='linux' and os.getuid()==os.getgid()==1000)
        info=ORIGINAL_RECORD.lstat()
        require(stat.S_ISREG(info.st_mode) and not ORIGINAL_RECORD.is_symlink() and info.st_uid==1000 and
                stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1 and info.st_size<=4194304)
        raw=ORIGINAL_RECORD.read_bytes();record=json.loads(raw)
        spec=importlib.util.spec_from_file_location('retire_tests',Path(__file__).with_name('2026-11-16-retire-tests.py'))
        parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
        reader=parent.Reader();state=reader.snapshot();allowed=admit(record,state)
        if args==['--inspect']:
            parent.select_plan(state)
            print('legacy_completion_admitted=true');return 0
        # This is a new action root with an independently bound three-container authority.
        # The original uncertain action record is preserved, never cleared or replayed.
        parent.EXPECTED_ACTORS=set(LEGACY)
        parent.ACTION=COMPLETION
        class CompletionReader(parent.Reader):
            def docker(self,*arguments):
                return super().docker(*bounded_stop_args(list(arguments),allowed))
        parent.execute(CompletionReader())
        require(ORIGINAL_RECORD.read_bytes()==raw and ORIGINAL_RECORD.stat().st_ino==info.st_ino)
        print('legacy_retirement_completion=true')
        return 0
    except Exception:
        print('legacy_retirement_completion_refused=true');return 1


if __name__=='__main__':raise SystemExit(main(sys.argv[1:]))
