"""User-authorized container-only retirement; preserve all volumes and journals."""
import collections
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

LATEST='fcd-support-host-test-p6-b1e183d'
COUNTS={
 'fcd-support-host-test-p6-7af70cc':5,'fcd-support-host-test-p6-6d0210d':5,
 'fcd-support-host-test-p6-67a4a4b':5,'fcd-support-host-test-p6-6faff8b':1,
 'fcd-support-host-test-p6-b0ba255':1,'fcd-support-host-test-p6-8ccb9a0':1,
 'fcd-support-host-test-p6-5d35777':1,
}
ACTION=Path('/home/redwan/fcd-support-retire-old-tests-20261103')
STAGE='admission'
ENV={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/home/redwan','LC_ALL':'C'}
FLAGS={'MODEL_EXECUTION_ENABLED=false','OUTBOUND_EXECUTION_ENABLED=false','N8N_EXECUTION_ENABLED=false'}


def require(ok):
 if not ok:raise RuntimeError('old_test_retirement_refused')


def select_targets(rows,latest=LATEST,counts=COUNTS):
 result=[];seen=set();observed=collections.Counter()
 for row in rows:
  require(row['id'] not in seen);seen.add(row['id'])
  project=row.get('project') or '';synthetic=row.get('synthetic') or '';parent=row.get('parent') or ''
  require(parent not in counts)
  if project not in counts and synthetic not in counts:continue
  require(latest not in [project,synthetic,parent])
  require(row['autoRemove'] is False)
  scope=project if project in counts else synthetic
  service=row.get('service')
  if service in ['fcd-support-api','fcd-support-admin','fcd-support-reply','postgres']:
   require(project==synthetic==scope and row['name']==scope+'-'+service+'-1')
  else:
   require(service is None and not project and synthetic==scope and row['name']==scope+'-ingress-peer')
  flags=row.get('flags',[])
  require(all(flag in FLAGS for flag in flags) and len(flags)==len(set(flags)))
  if service in ['fcd-support-api','fcd-support-admin','fcd-support-reply']:require(set(flags)==FLAGS)
  observed[scope]+=1;result.append(row)
 require(dict(observed)==counts)
 return result


def protected_projection(snapshot,removed):
 result=copy.deepcopy(snapshot)
 result['actors']=[row for row in result['actors'] if row['id'] not in removed]
 for network in result['networks']:
  for ident in removed:network['members'].pop(ident,None)
 return result


def run(args,timeout=30):
 p=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=timeout,env=ENV)
 require(p.returncode==0 and len(p.stdout)<=4194304 and len(p.stderr)<=1048576)
 return p.stdout.strip()


def remove_container(command,ident):
 require(re.fullmatch('[a-f0-9]{64}',ident) is not None)
 require(command(['docker','rm',ident])==ident)


def stop_container(command,ident):
 require(re.fullmatch('[a-f0-9]{64}',ident) is not None)
 # -1 tells the daemon never to escalate to SIGKILL. A client observation
 # timeout refuses this action; it does not authorize a later forced stop.
 require(command(['docker','stop','--time','-1',ident],timeout=80)==ident)


SHAPE='{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"synthetic":{{json (index .Config.Labels "fcd-support.synthetic-host-test")}},"parent":{{json (index .Config.Labels "fcd-support.operation.parent")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"image":{{json .Image}},"user":{{json .Config.User}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"autoRemove":{{json .HostConfig.AutoRemove}},"state":{{json .State.Status}},"health":{{with index .State "Health"}}{{json (index . "Status")}}{{else}}"none"{{end}},"started":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"exit":{{json .State.ExitCode}},"oom":{{json .State.OOMKilled}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .HostConfig.PortBindings}},"flags":[{{$sep := ""}}{{range .Config.Env}}{{$key := index (split . "=") 0}}{{if or (eq $key "MODEL_EXECUTION_ENABLED") (eq $key "OUTBOUND_EXECUTION_ENABLED") (eq $key "N8N_EXECUTION_ENABLED")}}{{$sep}}{{if or (eq . "MODEL_EXECUTION_ENABLED=false") (eq . "OUTBOUND_EXECUTION_ENABLED=false") (eq . "N8N_EXECUTION_ENABLED=false")}}{{json .}}{{else}}"invalid"{{end}}{{$sep = ","}}{{end}}{{end}}]}'


def actors():
 ids=run(['docker','ps','-aq','--no-trunc']).splitlines();require(1<=len(ids)<=1000)
 rows=[json.loads(line) for line in run(['docker','inspect','--format',SHAPE,*sorted(ids)]).splitlines()]
 for row in rows:
  row['name']=row['name'].lstrip('/')
  row['mounts']=sorted(row['mounts'],key=lambda value:json.dumps(value,sort_keys=True))
 return rows


def files():
 result={}
 for root in sorted(Path('/home/redwan').glob('fcd-support-host-test-p6-*/state')):
  require(root.resolve(strict=True)==root)
  for path in sorted(root.rglob('*')):
   info=path.lstat();require(not stat.S_ISLNK(info.st_mode))
   if stat.S_ISDIR(info.st_mode):continue
   require(stat.S_ISREG(info.st_mode) and info.st_uid==1000 and info.st_gid==1000
           and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1 and info.st_size<=4194304)
   result[str(path)]=[info.st_dev,info.st_ino,info.st_mtime_ns,hashlib.sha256(path.read_bytes()).hexdigest()]
 return result


def snapshot():
 networks=[]
 for ident in run(['docker','network','ls','-q']).splitlines():
  networks.append(json.loads(run(['docker','network','inspect','--format','{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"internal":{{json .Internal}},"driver":{{json .Driver}},"ipam":{{json .IPAM.Config}},"members":{{json .Containers}}}',ident])))
 volumes=[]
 for name in run(['docker','volume','ls','-q']).splitlines():
  volumes.append(json.loads(run(['docker','volume','inspect','--format','{"name":{{json .Name}},"created":{{json .CreatedAt}},"driver":{{json .Driver}},"scope":{{json .Scope}},"custom":{{if .Options}}true{{else}}false{{end}}}',name])))
 return {'actors':actors(),'networks':sorted(networks,key=lambda row:row['id']),
         'volumes':sorted(volumes,key=lambda row:row['name']),'files':files(),
         'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
         'daemon':run(['systemctl','show','docker.service','-p','InvocationID','--value'])}


def save(name,data):
 fd=os.open(ACTION/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as stream:
  stream.write(data);stream.flush();os.fsync(stream.fileno())
 fd=os.open(ACTION,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)


def identity(row):
 return {key:row[key] for key in ['id','name','project','synthetic','parent','service','revision','image','user','readonly','privileged','autoRemove','mounts','flags']}


def main():
 import fcntl
 global STAGE
 require(len(sys.argv)==2 and sys.argv[1] in ['--inspect','--cleanup'] and os.getuid()==os.getgid()==1000)
 require(not os.path.lexists(ACTION));os.environ.clear();os.environ.update(ENV)
 require(run(['docker','context','inspect','--format','{{(index .Endpoints "docker").Host}}',run(['docker','context','show'])])=='unix:///var/run/docker.sock')
 locks=[]
 try:
  for root in sorted(Path('/home/redwan').glob('fcd-support-host-test-p6-*/state')):
   if root.parent.name==LATEST:continue
   info=root.lstat();require(stat.S_ISDIR(info.st_mode) and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(1000,1000,0o700) and root.resolve(strict=True)==root)
   lock=root/'deployment.lock';info=lock.lstat();require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(1000,1000,0o600))
   fd=os.open(lock,os.O_RDONLY|os.O_NOFOLLOW);locks.append(fd);require((os.fstat(fd).st_dev,os.fstat(fd).st_ino)==(info.st_dev,info.st_ino));fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  before=snapshot();targets=select_targets(before['actors']);ids={row['id'] for row in targets};all_ids={row['id'] for row in before['actors']}
  for root in sorted(Path('/home/redwan').glob('fcd-support-host-test-p6-*/state')):
   if root.parent.name==LATEST or not (root/'active-job').exists():continue
   record=dict(line.split('=',1) for line in (root/'active-job').read_text().splitlines())
   require(record['JOB_CONTAINER'] not in all_ids)
  protected=[row for row in before['actors'] if row['id'] not in ids]
  latest=[row for row in protected if row['project']==LATEST]
  require(len(latest)==4 and all(row['state']=='running' and row['health']=='healthy' and row['revision']=='24e56679c9c29823b210ca6991608f83de556156' for row in latest))
  admission={'fcd-support-fcd-support-api-1','fcd-support-postgres-1','fcd-support-cloudflared'}
  require({row['name'] for row in protected if row['name'] in admission}==admission)
  require(all(row['state']=='running' for row in protected if row['name'] in admission))
  protected_volumes={mount.get('Name') for row in protected for mount in row['mounts'] if mount['Type']=='volume'}
  require(all(mount.get('Name') not in protected_volumes for row in targets for mount in row['mounts'] if mount['Type']=='volume'))
  projection=protected_projection(before,ids)
  require(protected_projection(snapshot(),ids)==projection)
  print('retirement_read_only_admission_passed=true',flush=True);print('retirement_container_count='+str(len(targets)),flush=True)
  if sys.argv[1]=='--inspect':return
  os.umask(0o077);ACTION.mkdir(mode=0o700)
  save('before.json',json.dumps(before,sort_keys=True).encode());save('targets.json',json.dumps(targets,sort_keys=True).encode());save('retirement-started',b'container-only\n')
  order={'fcd-support-api':0,'fcd-support-reply':1,'fcd-support-admin':2,None:3,'postgres':4}
  ordered=sorted(targets,key=lambda row:(order[row['service']],row['name']))
  STAGE='graceful_stop'
  for index,row in enumerate(ordered):
   current=next(item for item in actors() if item['id']==row['id']);require(identity(current)==identity(row))
   require(current['state'] in ['running','restarting','exited'])
   if current['state']!='exited':stop_container(run,row['id'])
   current=next(item for item in actors() if item['id']==row['id']);require(identity(current)==identity(row) and current['state']=='exited')
   if row['service']=='postgres':require(current['exit']==0 and current['oom'] is False)
   save('stopped-'+str(index)+'.json',json.dumps(current,sort_keys=True).encode())
   print('old_test_containers_stopped='+str(index+1),flush=True)
  require(protected_projection(snapshot(),ids)==projection)
  STAGE='remove_stopped_containers'
  for row in ordered:
   current=next(item for item in actors() if item['id']==row['id']);require(identity(current)==identity(row) and current['state']=='exited')
   remove_container(run,row['id'])
  STAGE='final_preservation'
  after=snapshot();require(not ids.intersection(row['id'] for row in after['actors']))
  require(protected_projection(after,ids)==projection)
  save('survivors-baseline.json',json.dumps(after,sort_keys=True).encode())
  save('retirement-completed.json',json.dumps({'removed':len(targets),'latestPreserved':True,'connectedWebhookPreserved':True,'volumesAndJournalsPreserved':True},sort_keys=True).encode())
  print('old_test_containers_removed='+str(len(targets)),flush=True)
  print('latest_and_connected_webhook_and_other_projects_preserved=true',flush=True)
  print('all_volumes_networks_and_uncertain_records_preserved=true',flush=True)
 finally:
  for fd in locks:os.close(fd)


if __name__=='__main__':
 try:main()
 except Exception:
  print('old_test_retirement_refused_stage='+STAGE,flush=True);raise SystemExit(1)
