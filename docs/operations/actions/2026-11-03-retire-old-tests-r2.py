"""Continue the exact archived retirement after a deprecated CLI receipt refusal."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

ORIGINAL=Path('/home/redwan/fcd-support-retire-old-tests-20261103')
ACTION=Path('/home/redwan/fcd-support-retire-old-tests-20261103-r2')
LIBRARY=Path('/home/redwan/fcd-support-retire-old-tests-20261103.py')
STAGE='original_evidence'


def require(ok):
 if not ok:raise RuntimeError('retirement_continuation_refused')


def canonical_arguments(args):
 if args[:2]==['docker','stop']:
  require(len(args)==5 and args[2:4]==['--time','-1'] and re.fullmatch('[a-f0-9]{64}',args[4]) is not None)
  return ['docker','stop','--timeout','-1',args[4]]
 return list(args)


def verify_continuation(before,targets,current,project,identity):
 ids={row['id'] for row in targets};require(len(ids)==len(targets))
 present={row['id']:row for row in current['actors']};require(len(present)==len(current['actors']) and ids<=present.keys())
 for row in targets:
  now=present[row['id']]
  require(identity(now)==identity(row) and now['state'] in ['running','restarting','exited'])
 require(project(before,ids)==project(current,ids))


def read(path,mode=0o600,limit=4194304):
 before=path.lstat();require(stat.S_ISREG(before.st_mode) and before.st_nlink==1
  and (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))==(1000,1000,mode) and before.st_size<=limit)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  opened=os.fstat(stream.fileno());data=stream.read(limit+1);after=os.fstat(stream.fileno())
 require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(opened.st_dev,opened.st_ino,opened.st_size,opened.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) and len(data)==before.st_size)
 return data


def main():
 global STAGE
 require(len(sys.argv)==2 and sys.argv[1] in ['--inspect','--cleanup'] and os.getuid()==os.getgid()==1000)
 require(ORIGINAL.resolve(strict=True)==ORIGINAL and not os.path.lexists(ACTION))
 info=ORIGINAL.lstat();require(stat.S_ISDIR(info.st_mode) and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(1000,1000,0o700))
 require(read(ORIGINAL/'retirement-started')==b'container-only\n' and not os.path.lexists(ORIGINAL/'retirement-completed.json'))
 before=json.loads(read(ORIGINAL/'before.json'));targets=json.loads(read(ORIGINAL/'targets.json'))
 require(len(targets)==19)
 code=read(LIBRARY,mode=0o400,limit=131072)
 require(hashlib.sha256(code).hexdigest()=='9ead80ef69b8eb63215eb91f70afa8f18ca308e3e94d4de29e8f923e7d0a2528')
 lib={'__name__':'reviewed_retirement_library','__file__':str(LIBRARY)};exec(compile(code,str(LIBRARY),'exec'),lib)
 command=lib['run'];snapshot=lib['snapshot'];checked=False
 def canonical_command(args,timeout=30):return command(canonical_arguments(args),timeout=timeout)
 def admitted_snapshot():
  nonlocal checked
  current=snapshot()
  if not checked:
   # The inherited main has acquired all old deployment locks at this point.
   # Require the original exact physical targets and unchanged survivors.
   chosen=lib['select_targets'](current['actors'])
   require({row['id'] for row in chosen}=={row['id'] for row in targets})
   verify_continuation(before,targets,current,lib['protected_projection'],lib['identity'])
   checked=True;print('original_retirement_scope_and_survivors_verified=true',flush=True)
  return current
 # Reuse the reviewed selection/locking/archive/stop/remove/comparison logic.
 # Only the output directory and deprecated CLI transport spelling change.
 lib['ACTION']=ACTION;lib['run']=canonical_command;lib['snapshot']=admitted_snapshot
 STAGE='reviewed_continuation'
 lib['main']()


if __name__=='__main__':
 try:main()
 except Exception:
  print('retirement_continuation_refused_stage='+STAGE,flush=True);raise SystemExit(1)
