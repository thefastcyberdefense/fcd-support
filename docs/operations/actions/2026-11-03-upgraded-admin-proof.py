"""Recheck the existing synthetic identity after upgrade; never bootstraps one."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
from functools import partial

TARGET = '24e56679c9c29823b210ca6991608f83de556156'
PROJECT = 'fcd-support-host-test-p6-b1e183d'
STAGE = 'client_admission'


def require(ok):
    if not ok: raise RuntimeError('upgraded_admin_proof_refused')


def decode_credentials(body):
    require(isinstance(body, str) and 0 < len(body) <= 4096)
    def fields(pairs):
        require(len(dict(pairs)) == len(pairs))
        return dict(pairs)
    try: value = json.loads(body, object_pairs_hook=fields)
    except (ValueError, TypeError): raise RuntimeError('upgraded_admin_proof_refused') from None
    require(isinstance(value, dict) and set(value) == {'login', 'password', 'seed'}
            and all(isinstance(item, str) for item in value.values())
            and value['login'] == 'synthetic_task16_b1e183d'
            and re.fullmatch('synthetic_[A-Za-z0-9_-]{40,80}', value['password']) is not None
            and re.fullmatch('[A-Z2-7]{32}', value['seed']) is not None)
    return value


SERVER_READ = r'''
import json,os,stat,subprocess
from pathlib import Path
def require(ok):
 if not ok:raise RuntimeError('upgraded_admin_server_refused')
def run(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=20,cwd='/home/redwan/apps/fcd-support')
 require(p.returncode==0);return p.stdout.strip()
try:
 require(os.getuid()==1000 and os.getgid()==1000)
 os.environ.clear();os.environ.update({'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/home/redwan','LC_ALL':'C'})
 require(run(['git','rev-parse','HEAD'])==TARGET and run(['git','status','--porcelain=v1','--untracked-files=all'])=='')
 root=Path('/home/redwan')/PROJECT
 selection=dict(line.split('=',1) for line in (root/'state/deployment-state').read_text().splitlines())
 require(selection['STATE_PHASE']=='ready' and selection['STATE_REVISION']==TARGET and selection['STATE_PROJECT']==PROJECT and not os.path.lexists(root/'state/active-job'))
 completed=json.loads(Path('/home/redwan/fcd-support-p6-timer-upgrade-20261103/upgrade-completed.json').read_text())
 require(completed['revision']==TARGET)
 ids=run(['docker','ps','--quiet','--no-trunc','--filter','label=com.docker.compose.project='+PROJECT,'--filter','label=com.docker.compose.service=fcd-support-admin']).splitlines()
 require(len(ids)==1)
 state=run(['docker','inspect','--format','{{.State.Running}}/{{.State.Health.Status}}/{{index .Config.Labels "org.opencontainers.image.revision"}}/{{.Config.User}}',ids[0]])
 require(state in ['true/healthy/'+TARGET+'/'+user for user in ['node','1000','1000:1000']])
 require(run(['docker','exec',ids[0],'/usr/bin/id','-u'])=='1000' and run(['docker','exec',ids[0],'/usr/bin/id','-g'])=='1000')
 action=Path('/home/redwan/fcd-support-p6-final-b1e183d');info=action.lstat()
 require(action.resolve(strict=True)==action and stat.S_ISDIR(info.st_mode) and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(1000,1000,0o700))
 path=action/'synthetic-admin-proof-credentials.json';before=path.lstat()
 require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))==(1000,1000,0o600) and before.st_size<=4096)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  opened=os.fstat(stream.fileno());data=stream.read(4097);after=os.fstat(stream.fileno())
 require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(opened.st_dev,opened.st_ino,opened.st_size,opened.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) and len(data)==before.st_size)
 print(data.decode('utf-8'),end='')
except Exception:raise SystemExit(1)
'''


def main():
    global STAGE
    require(os.name == 'nt')
    library = Path(__file__).with_name('2026-11-03-admin-ssh-proof-r2.py')
    body = library.read_bytes()
    require(hashlib.sha256(body).hexdigest() == 'fbf528092d2df63a16b8cfd62412961dc52b385c731b74572bc19eb27e86e94a')
    lib = {'__name__': 'reviewed_ssh_request_library', '__file__': str(library)}
    exec(compile(body, str(library), 'exec'), lib)
    with socket.socket() as probe: probe.bind(('127.0.0.1', 13004))
    STAGE = 'existing_server_identity_admission'
    program = 'TARGET=' + repr(TARGET) + '\nPROJECT=' + repr(PROJECT) + '\n' + SERVER_READ
    received = subprocess.run(lib['SSH'] + ['redwan@192.168.10.40', 'python3 -I -B -'],
                              input=program, capture_output=True, text=True, timeout=90)
    require(received.returncode == 0 and received.stderr == '')
    payload = decode_credentials(received.stdout)
    STAGE = 'owned_ssh_forward'
    forward = subprocess.Popen(lib['SSH'] + ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=2', '-L', '127.0.0.1:13004:/home/redwan/' + PROJECT + '/socket/admin.sock',
        'redwan@192.168.10.40'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        send = partial(lib['request'], owner_pid=forward.pid)
        deadline = time.monotonic() + 12
        while True:
            require(forward.poll() is None)
            try:
                with socket.create_connection(('127.0.0.1', 13004), timeout=0.2): break
            except OSError:
                require(time.monotonic() < deadline); time.sleep(0.1)
        STAGE = 'existing_password_mfa'
        require(send('GET', '/login')[0] == 200 and send('GET', '/knowledge')[:2] == (303, '/login'))
        status, location, cookies = send('POST', '/login', {'loginName': payload['login'], 'password': payload['password']}, origin=lib['ORIGIN'])
        require((status, location) == (303, '/mfa') and set(cookies) == {'fcd_admin_session', 'fcd_admin_csrf'})
        require(send('GET', '/mfa', cookies=cookies)[0] == 200)
        status, location, cookies = send('POST', '/mfa', {'code': lib['totp'](payload['seed']), 'csrfToken': cookies['fcd_admin_csrf']}, cookies=cookies, origin=lib['ORIGIN'])
        require((status, location) == (303, '/knowledge'))
        STAGE = 'authenticated_pages_and_logout'
        require(send('GET', '/knowledge', cookies=cookies)[0] == 200)
        require(send('GET', '/operations', cookies=cookies)[0] == 200)
        require(send('POST', '/logout', {'csrfToken': cookies['fcd_admin_csrf']}, cookies=cookies, origin=lib['ORIGIN'])[:2] == (303, '/login'))
        require(send('GET', '/knowledge', cookies=cookies)[:2] == (303, '/login'))
        print('upgraded_existing_identity_password_mfa_dashboard_logout_passed=true', flush=True)
    finally:
        if forward.poll() is None:
            forward.terminate()
            try: forward.wait(timeout=5)
            except subprocess.TimeoutExpired: forward.kill(); forward.wait(timeout=5)
        require(forward.poll() is not None)
    print('upgraded_owned_ssh_forward_reaped=true', flush=True)


if __name__ == '__main__':
    try: main()
    except Exception:
        print('upgraded_admin_proof_refused_stage=' + STAGE, flush=True)
        raise SystemExit(1)
