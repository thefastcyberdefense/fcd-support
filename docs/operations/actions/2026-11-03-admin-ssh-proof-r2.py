"""One-use synthetic identity and real SSH-forward proof for the fresh test scope."""

import base64
import hashlib
import hmac
from functools import partial
import http.client
from http.cookies import SimpleCookie
import json
import os
import secrets
import socket
import struct
import subprocess
import time
from urllib.parse import urlencode

REVISION = 'b1e183df3e7c319483f863346925b38c4f149ba5'
PROJECT = 'fcd-support-host-test-p6-' + REVISION[:7]
ADMIN_SERVICE = 'fcd-support-admin'
ADMIN_USERS = ['node', '1000', '1000:1000']
ACTION = '/home/redwan/fcd-support-p6-final-' + REVISION[:7]
ORIGIN = 'http://127.0.0.1:13004'
SSH = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']

BOOTSTRAP = r'''
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {loadRoleEnvironment} from './dist/operations/secret-files.js';
import {loadAdminConfig} from './dist/admin/admin-config.js';
import {runAdminBootstrap} from './dist/admin/admin-bootstrap.js';
import {AdminSecretText} from './dist/admin/admin-types.js';
import {AesGcmAdminSecretProtector} from './dist/admin/mfa.js';
import {PostgresAdminIdentity} from './dist/persistence/postgres-admin-identity.js';
let pool;
try {
 let text=''; for await(const chunk of process.stdin) { text+=chunk; if(text.length>4096) throw 0; }
 const input=JSON.parse(text), env=await loadRoleEnvironment('admin',process.env);
 if(['MODEL_EXECUTION_ENABLED','OUTBOUND_EXECUTION_ENABLED','N8N_EXECUTION_ENABLED'].some(key=>env[key]!=='false')) throw 0;
 const c=loadAdminConfig(env);
 if(c.origin!=='http://127.0.0.1:13004'||c.listener.kind!=='unix') throw 0;
 pool=new pg.Pool({connectionString:c.databaseUrl,max:1,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});
 const identity=new PostgresAdminIdentity(pool,{mfaProtector:new AesGcmAdminSecretProtector(c.mfaKeyVersion,c.mfaEncryptionKey),passwordPolicy:c.passwordPolicy,preauthenticationTtlMilliseconds:c.preauthenticationTtlMilliseconds,sessionHmacKey:c.sessionHmacKey,sessionTtlMilliseconds:c.sessionTtlMilliseconds,totpPolicy:c.totpPolicy});
 const values=[input.login,input.password,input.seed];
 await runAdminBootstrap({identity,accountRefSource:()=>`ADMIN_${randomUUID().replaceAll('-','')}`,requestKeySource:()=>`REQUEST_synthetic_ssh_${randomUUID().replaceAll('-','')}`,now:()=>new Date(),io:{readSecret:async()=>new AdminSecretText(values.shift()),write:()=>{}}});
 process.stdout.write('synthetic_admin_bootstrap_passed=true\n');
} catch { process.exitCode=1; } finally { await pool?.end(); }
'''

SERVER = r'''
import json,os,re,stat,subprocess
from pathlib import Path
def require(ok):
 if not ok: raise RuntimeError('synthetic_admin_proof_refused')
def private(path):
 info=path.lstat(); require(path.resolve(strict=True)==path and info.st_uid==1000 and info.st_gid==1000)
 require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1)
 return path.read_bytes()
def run(args):
 result=subprocess.run(args,capture_output=True,text=True,timeout=15)
 require(result.returncode==0 and len(result.stdout)<16384); return result.stdout.strip()
require(os.getuid()==1000 and os.getgid()==1000)
root=Path(action); info=root.lstat(); require(root.resolve(strict=True)==root and stat.S_IMODE(info.st_mode)==0o700 and info.st_uid==1000 and info.st_gid==1000)
require(private(root/'deployment-completed')==b'completed\n')
require(run(['git','-C','/home/redwan/apps/fcd-support','rev-parse','HEAD'])==revision)
require(not run(['git','-C','/home/redwan/apps/fcd-support','status','--porcelain=v1','--untracked-files=all']))
fixture=Path('/home/redwan')/project
require(not os.path.lexists(fixture/'state/active-job'))
state=dict(line.split('=',1) for line in private(fixture/'state/deployment-state').decode().splitlines())
require(state['STATE_PHASE']=='ready' and state['STATE_REVISION']==revision)
socket=fixture/'socket/admin.sock'; require(stat.S_ISSOCK(socket.lstat().st_mode) and socket.lstat().st_uid==1000)
ids=run(['docker','ps','-q','--no-trunc','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+admin_service]).splitlines()
require(len(ids)==1 and re.fullmatch('[a-f0-9]{64}',ids[0]))
shape='{"state":{{json .State.Status}},"health":{{json .State.Health.Status}},"user":{{json .Config.User}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}'
policy=json.loads(run(['docker','inspect','--format',shape,ids[0]]))
require(policy['state']=='running' and policy['health']=='healthy' and policy['user'] in admin_users and policy['readonly'] is True and policy['revision']==revision)
run(['docker','exec',ids[0],'node','--input-type=module','-e','process.exit(process.getuid()===1000&&process.getgid()===1000?0:1)'])
require(run(['docker','inspect','--format','{{json .HostConfig.PortBindings}}',ids[0]]) in ['{}','null'])
os.umask(0o077)
fd=os.open(root/'synthetic-admin-proof-credentials.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as stream: json.dump(payload,stream); stream.flush(); os.fsync(stream.fileno())
result=subprocess.run(['docker','exec','-i','--user','1000:1000',ids[0],'node','--input-type=module','-e',bootstrap],input=json.dumps(payload),capture_output=True,text=True,timeout=30)
require(result.returncode==0 and result.stdout=='synthetic_admin_bootstrap_passed=true\n' and not result.stderr)
fd=os.open(root/'synthetic-admin-bootstrap-completed',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb') as stream: stream.write(b'completed\n'); stream.flush(); os.fsync(stream.fileno())
print('synthetic_admin_bootstrap_passed=true')
'''


def require(ok):
    if not ok:
        raise RuntimeError('ssh_admin_proof_refused')


def request(method, path, fields=None, cookies=None, origin=None, *, owner_pid=None):
    require(os.name == 'nt' and type(owner_pid) is int and owner_pid > 0)
    headers = {}
    if origin is not None: headers['Origin'] = origin
    if cookies: headers['Cookie'] = '; '.join(key+'='+value for key,value in cookies.items())
    body = None
    if fields is not None:
        body=urlencode(fields); headers['Content-Type']='application/x-www-form-urlencoded'
    connection=http.client.HTTPConnection('127.0.0.1',13004,timeout=5)
    try:
        connection.connect()
        local_port=connection.sock.getsockname()[1]
        require(type(local_port) is int and 1 <= local_port <= 65535)
        # Bind this established TCP connection to the SSH process we created.
        # A listener-only check can race replacement before connect().
        command='(Get-NetTCPConnection -State Established -LocalAddress 127.0.0.1 -LocalPort 13004 -RemoteAddress 127.0.0.1 -RemotePort '+str(local_port)+' -ErrorAction Stop).OwningProcess'
        owner=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',command],capture_output=True,text=True,timeout=8)
        require(owner.returncode == 0 and owner.stdout.strip() == str(owner_pid))
        connection.request(method,path,body,headers)
        response=connection.getresponse(); content=response.read(1048577)
        require(len(content)<=1048576)
        jar=dict(cookies or {})
        for key,value in response.getheaders():
            if key.lower()=='set-cookie':
                parsed=SimpleCookie(); parsed.load(value)
                jar.update({name:item.value for name,item in parsed.items()})
        return response.status,response.getheader('Location'),jar
    finally: connection.close()


def totp(seed):
    digest=hmac.new(base64.b32decode(seed),struct.pack('>Q',int(time.time())//30),hashlib.sha1).digest()
    offset=digest[-1]&15
    return str((struct.unpack('>I',digest[offset:offset+4])[0]&0x7fffffff)%1000000).zfill(6)


def main():
    require(os.name == 'nt')
    # Refuse an occupied browser port before creating an identity.
    with socket.socket() as probe: probe.bind(('127.0.0.1',13004))
    payload={'login':'synthetic_task16_'+REVISION[:7],'password':'synthetic_'+secrets.token_urlsafe(36),'seed':base64.b32encode(secrets.token_bytes(20)).decode()}
    program='revision='+repr(REVISION)+'\nproject='+repr(PROJECT)+'\naction='+repr(ACTION)+'\nadmin_service='+repr(ADMIN_SERVICE)+'\nadmin_users='+repr(ADMIN_USERS)+'\npayload='+repr(payload)+'\nbootstrap='+repr(BOOTSTRAP)+'\n'+SERVER
    created=subprocess.run(SSH+['redwan@192.168.10.40','python3 -B -'],input=program,capture_output=True,text=True,timeout=55)
    require(created.returncode==0 and created.stdout=='synthetic_admin_bootstrap_passed=true\n' and not created.stderr)
    print('ssh_proof_synthetic_identity_created=true',flush=True)
    forward=subprocess.Popen(SSH+['-N','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-L','127.0.0.1:13004:/home/redwan/'+PROJECT+'/socket/admin.sock','redwan@192.168.10.40'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        send=partial(request,owner_pid=forward.pid)
        deadline=time.monotonic()+12
        while True:
            require(forward.poll() is None)
            try:
                with socket.create_connection(('127.0.0.1',13004),timeout=0.2): break
            except OSError:
                require(time.monotonic()<deadline); time.sleep(0.1)
        require(send('GET','/login')[0]==200)
        require(send('GET','/knowledge')[:2]==(303,'/login'))
        credentials={'loginName':payload['login'],'password':payload['password']}
        require(send('POST','/login',credentials)[0]==403)
        require(send('POST','/login',credentials,origin='http://example.invalid')[0]==403)
        require(send('POST','/login',{'loginName':payload['login'],'password':'synthetic_wrong_password'},origin=ORIGIN)[0]==401)
        status,location,cookies=send('POST','/login',credentials,origin=ORIGIN)
        require((status,location)==(303,'/mfa') and set(cookies)=={'fcd_admin_session','fcd_admin_csrf'})
        require(send('GET','/mfa',cookies=cookies)[0]==200)
        require(send('POST','/mfa',{'code':totp(payload['seed']),'csrfToken':'synthetic_wrong_csrf'},cookies,ORIGIN)[0]==401)
        status,location,cookies=send('POST','/mfa',{'code':totp(payload['seed']),'csrfToken':cookies['fcd_admin_csrf']},cookies,ORIGIN)
        require((status,location)==(303,'/knowledge'))
        require(send('GET','/knowledge',cookies=cookies)[0]==200)
        require(send('GET','/operations',cookies=cookies)[0]==200)
        require(send('POST','/logout',{'csrfToken':'synthetic_wrong_csrf'},cookies,ORIGIN)[0]==403)
        require(send('POST','/logout',{'csrfToken':cookies['fcd_admin_csrf']},cookies,ORIGIN)[:2]==(303,'/login'))
        require(send('GET','/knowledge',cookies=cookies)[:2]==(303,'/login'))
        print('ssh_unix_forward_password_mfa_dashboard_origin_csrf_logout_passed=true',flush=True)
    finally:
        if forward.poll() is None:
            forward.terminate()
            try: forward.wait(timeout=5)
            except subprocess.TimeoutExpired: forward.kill(); forward.wait(timeout=5)
        require(forward.poll() is not None)
        print('ssh_owned_forward_process_reaped=true',flush=True)


if __name__ == '__main__':
    try: main()
    except Exception:
        print('ssh_admin_proof_refused=true',flush=True)
        raise SystemExit(1)
