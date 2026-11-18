"""One-use first private administrator setup and Unix authentication proof."""
import ast
import base64
import hashlib
import hmac
import http.client
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import secrets
import socket
import struct
import subprocess
import sys
import time
from urllib.parse import urlencode

PROJECT='fcd-support-host-test-v1-c2d8225'
REVISION='c2d8225d2a096e2d4f406c35f8ab170a6dad2f80'
HOME=Path('/home/redwan')
SOURCE=HOME/'fcd-support-v1-source-c2d8225'
FIXTURE=HOME/PROJECT
DEPLOYMENT=HOME/'fcd-support-v1-action-20261116-r2/deployment.json'
ACTION=HOME/'fcd-support-v1-admin-20261116'
ORIGIN='http://127.0.0.1:13004'
D=['docker','--host','unix:///var/run/docker.sock']
FLAGS={'MODEL_EXECUTION_ENABLED=false','OUTBOUND_EXECUTION_ENABLED=false','N8N_EXECUTION_ENABLED=false'}


class Refusal(Exception):pass


def require(value):
    if not value:raise Refusal('private_admin_refused')


def select_admin(record,actors):
    require(record.get('phase')=='complete' and record.get('revision')==REVISION and len(actors)==1)
    row=actors[0]
    require(re.fullmatch('[a-f0-9]{64}',row['id']) and row['project']==PROJECT and row['name']==PROJECT+'-fcd-support-admin-1')
    require(row['revision']==REVISION and row['user'] in ['node','1000','1000:1000'] and row['readonly'] and row['ports'] in [None,{}])
    require(row['running'] and row['health']=='healthy' and len(row['flags'])==3 and set(row['flags'])==FLAGS)
    return row['id']


def run(args,input_text=None,timeout=30):
    result=subprocess.run(args,input=input_text,capture_output=True,text=True,timeout=timeout,
                          env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(HOME),'LC_ALL':'C'})
    require(result.returncode==0 and len(result.stdout)<=1048576 and len(result.stderr)<=1048576)
    return result.stdout.strip()


def private_file(path,text):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w',newline='\n') as stream:stream.write(text);stream.flush();os.fsync(stream.fileno())


def request(method,path,fields=None,cookies=None,origin=None):
    class UnixConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(5)
            self.sock.connect(str(FIXTURE/'socket/admin.sock'))
    connection=UnixConnection('127.0.0.1:13004',timeout=5)
    headers={}
    if origin is not None:headers['Origin']=origin
    if cookies:headers['Cookie']='; '.join(key+'='+value for key,value in cookies.items())
    body=None
    if fields is not None:body=urlencode(fields);headers['Content-Type']='application/x-www-form-urlencoded'
    try:
        connection.request(method,path,body,headers);response=connection.getresponse();content=response.read(1048577)
        require(len(content)<=1048576)
        jar=dict(cookies or {})
        for key,value in response.getheaders():
            if key.lower()=='set-cookie':
                parsed=SimpleCookie();parsed.load(value);jar.update({name:item.value for name,item in parsed.items()})
        return response.status,response.getheader('Location'),jar
    finally:connection.close()


def totp(seed):
    digest=hmac.new(base64.b32decode(seed),struct.pack('>Q',int(time.time())//30),hashlib.sha1).digest()
    offset=digest[-1]&15
    return str((struct.unpack('>I',digest[offset:offset+4])[0]&0x7fffffff)%1000000).zfill(6)


def execute():
    require(sys.platform=='linux' and os.getuid()==os.getgid()==1000 and HOME.resolve()==HOME)
    require(not ACTION.exists() and not ACTION.is_symlink())
    require(run(['git','-c','core.fsmonitor=false','-C',str(SOURCE),'rev-parse','HEAD'])==REVISION)
    require(not run(['git','-c','core.fsmonitor=false','-C',str(SOURCE),'status','--porcelain']))
    ids=run(D+['ps','--all','--quiet','--no-trunc','--filter','label=com.docker.compose.project='+PROJECT,'--filter','label=com.docker.compose.service=fcd-support-admin']).split()
    require(len(ids)==1)
    fmt='{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"user":{{json .Config.User}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"ports":{{json .HostConfig.PortBindings}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}}}'
    row=json.loads(run(D+['container','inspect','--format',fmt,ids[0]]));row['name']=row['name'].lstrip('/')
    flags='{{range .Config.Env}}{{if or (eq . "MODEL_EXECUTION_ENABLED=false") (eq . "OUTBOUND_EXECUTION_ENABLED=false") (eq . "N8N_EXECUTION_ENABLED=false")}}{{println .}}{{end}}{{end}}'
    row['flags']=run(D+['container','inspect','--format',flags,ids[0]]).splitlines()
    ident=select_admin(json.loads(DEPLOYMENT.read_text()),[row])
    # Reuse only the generic exported bootstrap API adapter from the accepted source.
    # No historical Python action, account, key, or old credential file is executed/read.
    tree=ast.parse((SOURCE/'docs/operations/actions/2026-11-03-admin-ssh-proof-r2.py').read_text())
    adapters=[ast.literal_eval(node.value) for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BOOTSTRAP' for t in node.targets)]
    require(len(adapters)==1 and isinstance(adapters[0],str))
    ACTION.mkdir(mode=0o700)
    record={'phase':'intent','revision':REVISION,'bootstrap':'pending'}
    private_file(ACTION/'intent.json',json.dumps(record))
    payload={'login':'synthetic_v1_owner','password':'synthetic_'+secrets.token_urlsafe(36),'seed':base64.b32encode(secrets.token_bytes(20)).decode()}
    private_file(ACTION/'initial-admin.json',json.dumps(payload))
    output=run(D+['exec','-i','--user','1000:1000',ident,'node','--input-type=module','-e',adapters[0]],json.dumps(payload),timeout=45)
    require(output=='synthetic_admin_bootstrap_passed=true')
    require(request('GET','/login')[0]==200 and request('GET','/knowledge')[:2]==(303,'/login'))
    credentials={'loginName':payload['login'],'password':payload['password']}
    require(request('POST','/login',credentials)[0]==403)
    require(request('POST','/login',credentials,origin='http://example.invalid')[0]==403)
    status,location,cookies=request('POST','/login',credentials,origin=ORIGIN)
    require((status,location)==(303,'/mfa') and set(cookies)=={'fcd_admin_session','fcd_admin_csrf'})
    require(request('POST','/mfa',{'code':totp(payload['seed']),'csrfToken':'synthetic_wrong_csrf'},cookies,ORIGIN)[0]==401)
    status,location,cookies=request('POST','/mfa',{'code':totp(payload['seed']),'csrfToken':cookies['fcd_admin_csrf']},cookies,ORIGIN)
    require((status,location)==(303,'/knowledge'))
    routes=['/knowledge','/questions','/insights','/policy','/escalations','/audit','/operations']
    for route in routes:require(request('GET',route,cookies=cookies)[0]==200)
    require(request('POST','/logout',{'csrfToken':cookies['fcd_admin_csrf']},cookies,ORIGIN)[:2]==(303,'/login'))
    require(request('GET','/knowledge',cookies=cookies)[:2]==(303,'/login'))
    private_file(ACTION/'completed.json',json.dumps({'phase':'complete','revision':REVISION,'authenticated_pages':len(routes),'logout_revoked':True}))
    print('private_admin_bootstrap_and_mfa_verified=true')
    print('private_admin_authenticated_pages='+str(len(routes)))
    print('private_admin_logout_verified=true')
    print('private_admin_credentials_stored_server_side=true')


if __name__=='__main__':
    try:
        require(sys.argv[1:]==['--create-first-private-admin']);execute()
    except Exception:
        print('private_admin_setup_refused=true');raise SystemExit(1)
