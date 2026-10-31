# Exact synthetic runbook executor; see ../phase-6-server-deployment.md.
# --inspect performs read-only checks and temporary shared locking only.
# --execute is single-use and refuses existing action/fixture namespaces.
# --audit only rechecks the saved old-state baseline after execution.
# It never resolves an old journal or starts a preserved restore target.
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys

REV = '67a4a4bede6d3252dc936a6e410f4b90c1359ac3'
OLD = '6faff8b37c6bd6d867c2cace30bdb0bc88578561'
ROOT = Path('/home/redwan/apps/fcd-support')
PROJECT = 'fcd-support-host-test-p6-67a4a4b'
TARGET = 'fcd-support-restore-host-test-p6-67a4a4b'
FIXTURE = Path('/home/redwan') / PROJECT
ACTION = Path('/home/redwan/fcd-support-p6-action-67a4a4b')
ADMISSION = ['fcd-support-fcd-support-api-1', 'fcd-support-postgres-1', 'fcd-support-cloudflared']
LOCKS = []
STAGE = 'arguments'

def require(value):
    if not value:
        raise RuntimeError('refused')

def run(args, timeout=30):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    if result.returncode != 0:
        if ACTION.is_dir() and len(sys.argv) == 2 and sys.argv[1] == '--execute':
            try:
                descriptor = os.open(ACTION / 'command-refusal.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, 'w', encoding='utf8') as output:
                    output.write(result.stderr[:65536]); output.flush(); os.fsync(output.fileno())
            except OSError:
                pass
        missing = re.search(r'map has no entry for key "([A-Za-z_]+)"', result.stderr)
        if missing and missing.group(1) in ['Health', 'RestartCount', 'User', 'Name', 'PortBindings']:
            print('server_metadata_field_missing=' + missing.group(1), flush=True)
    require(result.returncode == 0 and len(result.stdout) <= 2097152)
    return result.stdout.strip()

def protected(path, limit=262144):
    p = Path(path)
    before = p.lstat()
    require(stat.S_ISREG(before.st_mode) and (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink) == (1000, 1000, 0o600, 1) and before.st_size <= limit)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, 'rb') as source:
            opened = os.fstat(source.fileno())
            require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
            data = source.read(limit + 1)
            after = os.fstat(source.fileno())
    except BaseException:
        raise
    require(len(data) == before.st_size and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns))
    return data, [before.st_dev, before.st_ino, before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_size, before.st_mtime_ns, hashlib.sha256(data).hexdigest()]

def fields(path):
    result = {}
    for line in protected(path)[0].decode().splitlines():
        key, value = line.split('=', 1)
        require(key not in result)
        result[key] = value
    return result

def old_scope(name):
    return (name.startswith('fcd-support-host-test-p6-') or name.startswith('fcd-support-restore-host-test-p6-')) and not name.startswith(PROJECT) and not name.startswith(TARGET)

def snapshot():
    global STAGE
    previous_stage = STAGE
    STAGE = 'snapshot_state_inventory'
    files = {}
    for state in sorted(Path('/home/redwan').glob('fcd-support-host-test-p6-*/state')):
        if state.parent == FIXTURE:
            continue
        require(not state.is_symlink() and state.resolve() == state)
        for path in sorted(state.iterdir()):
            STAGE = 'snapshot_state_filename'
            require(re.fullmatch(r'(deployment\.lock|deployment-state(?:\.next)?|initial-deployment\.(?:record|intent)(?:\.next)?|active-job(?:[-.][a-z0-9]+)*|job-[a-f0-9]{32}\.json|(?:retained|volume)-[a-f0-9]{32,64}\.record(?:\.next)?|restore-[a-f0-9]{32}\.(?:intent|record|abandoned)(?:\.next)?)', path.name))
            STAGE = 'snapshot_protected_state_file'
            files[str(path)] = protected(path)[1]
    STAGE = 'snapshot_state_count'
    require(len(files) >= 10 and len(files) <= 1000)
    saved = Path('/home/redwan/fcd-support-host-test-p6-b0ba255/logs/retained.snapshot')
    files[str(saved)] = protected(saved)[1]
    STAGE = 'snapshot_actor_inventory'
    inventory = run(['docker', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "fcd-support.synthetic-host-test"}}|{{.Label "fcd-support.operation.parent"}}']).splitlines()
    require(len(inventory) <= 1000)
    ids = []
    for line in inventory:
        ident, name, project, synthetic, parent = line.split('|')
        if name in ADMISSION or any(old_scope(value) for value in [name, project, synthetic, parent]):
            require(re.fullmatch('[a-f0-9]{64}', ident))
            ids.append(ident)
    require(len(ids) >= 7)
    STAGE = 'snapshot_actor_projection'
    actor_format = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"configuredImage":{{json .Config.Image}},"user":{{json .Config.User}},"ro":{{json .HostConfig.ReadonlyRootfs}},"ports":{{json .HostConfig.PortBindings}},"state":{{json .State.Status}},"started":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"health":{{with index .State "Health"}}{{json (index . "Status")}}{{else}}"none"{{end}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}}}'
    actors = [json.loads(line) for line in run(['docker', 'container', 'inspect', '--format', actor_format, *sorted(ids)]).splitlines()]
    for actor in actors:
        actor['mounts'] = sorted(actor['mounts'], key=lambda mount: json.dumps(mount, sort_keys=True))
    network_names = {name for actor in actors for name in actor['networks']}
    STAGE = 'snapshot_network_projection'
    network_names.update(name for name in run(['docker', 'network', 'ls', '--format', '{{.Name}}']).splitlines() if old_scope(name))
    network_format = '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"driver":{{json .Driver}},"internal":{{json .Internal}},"ipam":{{json .IPAM}},"options":{{json .Options}},"labels":{{json .Labels}},"members":{{json .Containers}}}'
    networks = [json.loads(line) for line in run(['docker', 'network', 'inspect', '--format', network_format, *sorted(network_names)]).splitlines()]
    volumes = {mount['Name'] for actor in actors for mount in actor['mounts'] if mount['Type'] == 'volume'}
    STAGE = 'snapshot_volume_projection'
    volumes.update(name for name in run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines() if old_scope(name))
    volume_format = '{"name":{{json .Name}},"created":{{json .CreatedAt}},"driver":{{json .Driver}},"scope":{{json .Scope}},"options":{{json .Options}},"labels":{{json .Labels}}}'
    volume_data = [json.loads(line) for line in run(['docker', 'volume', 'inspect', '--format', volume_format, *sorted(volumes)]).splitlines()]
    STAGE = previous_stage
    return {'files': files, 'actors': actors, 'networks': networks, 'volumes': volume_data}

def assert_admission(baseline):
    global STAGE
    previous_stage = STAGE
    STAGE = 'admission_snapshot_shape'
    saved = protected('/home/redwan/fcd-support-host-test-p6-b0ba255/logs/retained.snapshot')[0].decode().strip().splitlines()
    require(len(saved) == 3)
    by_name = {actor['name'].lstrip('/'): actor for actor in baseline['actors']}
    for name, original in zip(ADMISSION, saved):
        STAGE = 'admission_actor_properties'
        actor = by_name[name]
        require(actor['id'] == original.split('/')[0] and original.split('/')[2] == 'true' and actor['state'] == 'running' and actor['health'] == 'healthy' and actor['ro'] and not actor['ports'])
    STAGE = 'admission_api_image'
    require(by_name[ADMISSION[0]]['configuredImage'] == 'fcd-support-api:207a5e6357c1e1a7c75918793262d835574d898d')
    STAGE = 'admission_tunnel_image'
    require(by_name[ADMISSION[2]]['configuredImage'] == 'fcd-support-cloudflared:207a5e6357c1e1a7c75918793262d835574d898d')
    pg = by_name[ADMISSION[1]]
    STAGE = 'admission_postgres_image'
    require(re.fullmatch(r'postgres:18\.4@sha256:[a-f0-9]{64}', pg['configuredImage']))
    STAGE = 'admission_postgres_volume'
    require(len(pg['mounts']) == 1 and pg['mounts'][0]['Name'] == 'fcd-support-postgres-data' and pg['mounts'][0]['Destination'] == '/var/lib/postgresql')
    STAGE = previous_stage

def stable(baseline):
    global STAGE
    previous_stage = STAGE
    current = snapshot()
    if current != baseline:
        for category in ['files', 'actors', 'networks', 'volumes']:
            if current[category] != baseline[category]:
                print('preservation_drift_category=' + category, flush=True)
        old_actors = {actor['id']: actor for actor in baseline['actors']}
        new_actors = {actor['id']: actor for actor in current['actors']}
        if old_actors.keys() != new_actors.keys():
            print('preservation_actor_identity_changed=true', flush=True)
        else:
            for field in ['name', 'image', 'configuredImage', 'user', 'ro', 'ports', 'state', 'started', 'restarts', 'health', 'networks', 'mounts']:
                if any(old_actors[ident][field] != new_actors[ident][field] for ident in old_actors):
                    print('preservation_actor_changed_field=' + field, flush=True)
        STAGE = 'preservation_drift'
        raise RuntimeError('refused')
    STAGE = 'running_operations_guard'
    require(not run(['docker', 'ps', '--quiet', '--no-trunc', '--filter', 'label=fcd-support.operation.parent']))
    STAGE = previous_stage

def check_subnet(cidr):
    candidate = ipaddress.ip_network(cidr, strict=True)
    routes = json.loads(run(['ip', '-j', '-4', 'route', 'show', 'table', 'all']))
    interfaces = json.loads(run(['ip', '-j', '-4', 'address', 'show']))
    require(isinstance(routes, list) and routes and isinstance(interfaces, list) and interfaces)
    for route in routes:
        require(isinstance(route.get('dst'), str))
        if route['dst'] not in ['default', '0.0.0.0/0']:
            require(not candidate.overlaps(ipaddress.ip_network(route['dst'], strict=False)))
    for interface in interfaces:
        for address in interface['addr_info']:
            require(address['family'] == 'inet')
            require(not candidate.overlaps(ipaddress.ip_network(str(address['local']) + '/' + str(address['prefixlen']), strict=False)))
    ids = run(['docker', 'network', 'ls', '--quiet', '--no-trunc']).splitlines()
    require(ids and len(ids) <= 1000)
    for line in run(['docker', 'network', 'inspect', '--format', '{{json .IPAM.Config}}', *ids]).splitlines():
        for config in json.loads(line) or []:
            value = config.get('Subnet')
            if value:
                subnet = ipaddress.ip_network(value, strict=True)
                require(subnet.version != 4 or not candidate.overlaps(subnet))

def logged(args, name, timeout=2400):
    fd = os.open(ACTION / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        process = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            require(process.wait(timeout=timeout) == 0)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try: process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
            raise
        output.flush(); os.fsync(output.fileno())

try:
    require(len(sys.argv) == 2 and sys.argv[1] in ['--inspect', '--execute', '--audit'])
    if sys.argv[1] == '--audit':
        STAGE = 'audit_baseline'
        baseline = json.loads(protected(ACTION / 'preserved-baseline.json')[0])
        assert_admission(baseline)
        stable(baseline)
        print('synthetic_action_saved_baseline_matches=true', flush=True)
        raise SystemExit(0)
    STAGE = 'preflight'
    require(os.getuid() == 1000 and os.getgid() == 1000 and ROOT.resolve() == ROOT and not FIXTURE.exists() and not ACTION.exists())
    require(run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']) == OLD and not run(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '--untracked-files=all']))
    require(run(['git', '-C', str(ROOT), 'remote', 'get-url', 'origin']) in ['https://github.com/thefastcyberdefense/fcd-support.git', 'https://github.com/thefastcyberdefense/fcd-support', 'git@github.com:thefastcyberdefense/fcd-support.git', 'git@github.com:thefastcyberdefense/fcd-support'])
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'))
    context = run(['docker', 'context', 'show'])
    require(run(['docker', 'context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}', context]) == 'unix:///var/run/docker.sock')
    require(run(['docker', 'info', '--format', '{{.DockerRootDir}}']) == '/var/lib/docker')
    space = os.statvfs('/var/lib/docker'); require(space.f_bavail * space.f_frsize >= 12 * 1024**3)
    ids = run(['docker', 'ps', '--all', '--quiet', '--no-trunc']).splitlines()
    mounts = run(['docker', 'container', 'inspect', '--format', '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}', *ids])
    for mount in mounts.splitlines():
        if not mount:
            continue
        require(os.path.commonpath([str(ROOT), mount]) not in [str(ROOT), mount])
    for state in sorted(Path('/home/redwan').glob('fcd-support-host-test-p6-*/state')):
        lock = state / 'deployment.lock'; protected(lock)
        fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW); fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB); LOCKS.append(fd)
    STAGE = 'preserved_state'
    for suffix, phase, service in [('b0ba255', 'uncertain', 'promote'), ('8ccb9a0', 'quiescent', 'restore'), ('6faff8b', 'uncertain', 'promote')]:
        STAGE = 'preserved_' + suffix + '_selection'
        state = Path('/home/redwan/fcd-support-host-test-p6-' + suffix) / 'state'
        require(fields(state / 'deployment-state')['STATE_PHASE'] == phase)
        STAGE = 'preserved_' + suffix + '_job'
        job = fields(state / 'active-job'); require(job['JOB_PHASE'] == 'uncertain' and job['JOB_SERVICE'] == service and job['JOB_CONTAINER'] not in ids)
        require(re.fullmatch('operation_[a-f0-9]{32}', job['JOB_REF']))
        STAGE = 'preserved_' + suffix + '_override'
        protected(state / ('job-' + job['JOB_REF'][len('operation_'):] + '.json'))
    STAGE = 'preserved_completed_restore'
    for suffix in ['b0ba255', '6faff8b']:
        completed = list((Path('/home/redwan/fcd-support-host-test-p6-' + suffix) / 'state').glob('restore-*.record'))
        require(len(completed) == 1 and fields(completed[0])['RESTORE_PHASE'] == 'completed')
    for index, project in enumerate(['fcd-support-host-test-p6-b0ba255', 'fcd-support-restore-host-test-p6-b0ba255', 'fcd-support-host-test-p6-8ccb9a0', 'fcd-support-restore-host-test-p6-8ccb9a0-r2', 'fcd-support-host-test-p6-6faff8b', 'fcd-support-restore-host-test-p6-6faff8b']):
        STAGE = 'preserved_database_' + str(index)
        actors = run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project, '--filter', 'label=com.docker.compose.service=postgres']).splitlines()
        require(len(actors) == 1)
        if index in [0, 2, 4]:
            require(run(['docker', 'inspect', '--format', '{{.State.Running}}/{{.State.Health.Status}}', actors[0]]) == 'true/healthy')
        else:
            require(run(['docker', 'inspect', '--format', '{{.State.Running}}/{{.State.Status}}/{{.HostConfig.RestartPolicy.Name}}', actors[0]]) == 'false/exited/no')
            state = Path('/home/redwan/fcd-support-host-test-p6-' + {1: 'b0ba255', 3: '8ccb9a0', 5: '6faff8b'}[index]) / 'state'
            matching = [record for record in [fields(path) for path in state.glob('restore-*.intent')] if record['RESTORE_TARGET_PROJECT'] == project]
            require(len(matching) == 1)
            record = matching[0]
            actual = run(['docker', 'inspect', '--format', '{{.Image}}/{{index .Config.Labels "fcd-support.restore.ref"}}/{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}', actors[0]])
            require(actual == record['RESTORE_PG_IMAGE'] + '/' + record['RESTORE_REF'] + '/' + record['RESTORE_TARGET_VOLUME'])
    STAGE = 'new_scope_absent'
    for project in [PROJECT, TARGET]:
        require(not run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project]))
        require(not run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=fcd-support.synthetic-host-test=' + project]))
    names = run(['docker', 'network', 'ls', '--format', '{{.Name}}']).splitlines()
    volumes = run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines()
    tags = run(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).splitlines()
    require(not any(name.startswith(PROJECT) or name.startswith(TARGET) for name in names + volumes + tags))
    STAGE = 'baseline'
    baseline = snapshot(); assert_admission(baseline); stable(baseline)
    STAGE = 'capacity'; check_subnet('198.19.0.0/20')
    print('synthetic_action_read_only_preflight=true', flush=True)
    if sys.argv[1] == '--execute':
        STAGE = 'record_baseline'
        os.umask(0o077); ACTION.mkdir(mode=0o700)
        with open(ACTION / 'preserved-baseline.json', 'x', encoding='utf8') as output:
            json.dump(baseline, output, sort_keys=True); output.flush(); os.fsync(output.fileno())
        descriptor = os.open(ACTION, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
        STAGE = 'checkout'
        logged(['git', 'fetch', '--no-tags', 'origin', 'main'], 'fetch.log', 120)
        logged(['git', 'checkout', '--detach', REV], 'checkout.log', 30)
        require(run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']) == REV and not run(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '--untracked-files=all']))
        stable(baseline)
        STAGE = 'bridges'
        roles = ['webhook', 'admin', 'reply', 'outbound', 'notification', 'operations', 'ingress', 'egress']
        for index, role in enumerate(roles):
            cidr = '198.19.' + str(index) + '.0/24'; check_subnet(cidr)
            name = PROJECT + '-' + role + ('-data' if index < 6 else '')
            require(name not in run(['docker', 'network', 'ls', '--format', '{{.Name}}']).splitlines())
            args = ['docker', 'network', 'create', '--driver', 'bridge', '--subnet', cidr, '--label', 'fcd-support.synthetic-host-test=' + PROJECT]
            if role != 'egress': args += ['--internal']
            if index < 6: args += ['--label', 'com.docker.compose.project=' + PROJECT, '--label', 'com.docker.compose.network=' + role + '_data']
            ident = run(args + [name]); require(re.fullmatch('[a-f0-9]{64}', ident))
            fact = run(['docker', 'network', 'inspect', '--format', '{{.Id}}|{{.Name}}|{{.Driver}}|{{.Internal}}|{{len .Containers}}|{{.IPAM.Driver}}|{{len .IPAM.Config}}|{{range .IPAM.Config}}{{.Subnet}}{{end}}', ident])
            require(fact == '|'.join([ident, name, 'bridge', str(role != 'egress').lower(), '0', 'default', '1', cidr]))
            stable(baseline)
        STAGE = 'bridge_guard'
        logged(['bash', '-c', 'source "$1/scripts/synthetic-host-networks.sh"; synthetic_precreated_network_snapshot "$2"', 'guard', str(ROOT), PROJECT], 'bridge-guard.log', 60)
        STAGE = 'deploy'
        print('synthetic_action_deployment_started=true', flush=True)
        logged(['bash', 'scripts/test-synthetic-runtime-deployment.sh', REV, '--synthetic-precreated'], 'deployment.log')
        STAGE = 'final_verification'
        stable(baseline)
        require(fields(FIXTURE / 'state/deployment-state')['STATE_PHASE'] == 'ready' and not (FIXTURE / 'state/active-job').exists())
        actors = run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + PROJECT]).splitlines()
        require(len(actors) == 4)
        require(all(line == 'true/healthy' for line in run(['docker', 'inspect', '--format', '{{.State.Running}}/{{.State.Health.Status}}', *actors]).splitlines()))
        require(not run(['docker', 'ps', '--all', '--quiet', '--filter', 'label=com.docker.compose.project=' + TARGET]))
        print('synthetic_action_deployment_verified=true', flush=True)
        print('synthetic_action_preserved_state_unchanged=true', flush=True)
except Exception:
    print('synthetic_action_refused_stage=' + STAGE, flush=True)
    raise SystemExit(1)
finally:
    for fd in LOCKS:
        os.close(fd)
