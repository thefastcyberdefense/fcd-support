# Single-use fresh67 stale-socket recovery and separately gated rollback.
# Original drill remains stopped; no uncertain scope is retried or resolved.
# Strictly admit observed reboot metadata, then pin a separate current baseline.
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

def reboot_compatible(before, after):
    # Only running-actor start/endpoints and the default bridge identity may
    # differ. Every unknown field, mount, static address request and member
    # identity remains authoritative; duplicates are never collapsed silently.
    require(before.keys() == after.keys() == {'files', 'actors', 'networks', 'volumes'})
    require(before['files'] == after['files'] and before['volumes'] == after['volumes'])
    def indexed(values, key):
        result = {item[key]: item for item in values}
        require(len(result) == len(values))
        return result
    def without(value, keys):
        return {key: item for key, item in value.items() if key not in keys}
    old_networks = indexed(before['networks'], 'name'); new_networks = indexed(after['networks'], 'name')
    require(old_networks.keys() == new_networks.keys() and 'bridge' in old_networks)
    require(old_networks['bridge']['id'] != new_networks['bridge']['id'])
    require(old_networks['bridge']['created'] != new_networks['bridge']['created'])
    endpoint_fields = {'EndpointID', 'IPAddress', 'GlobalIPv6Address', 'MacAddress'}
    old_actors = indexed(before['actors'], 'id'); new_actors = indexed(after['actors'], 'id')
    require(old_actors.keys() == new_actors.keys())
    running = 0
    for ident, old in old_actors.items():
        new = new_actors[ident]
        if old['state'] != 'running':
            require(old == new)
            continue
        running += 1
        require(old['started'] != new['started'])
        require(without(old, {'started', 'networks'}) == without(new, {'started', 'networks'}))
        require(old['networks'].keys() == new['networks'].keys())
        for name, previous in old['networks'].items():
            current = new['networks'][name]
            require(previous.keys() == current.keys())
            omitted = endpoint_fields | ({'NetworkID'} if name == 'bridge' else set())
            require(without(previous, omitted) == without(current, omitted))
            if name == 'bridge':
                require(previous['NetworkID'] == old_networks[name]['id'] and current['NetworkID'] == new_networks[name]['id'])
    require(running > 0)
    for name, old in old_networks.items():
        new = new_networks[name]
        require(old.keys() == new.keys())
        omitted = {'members'} | ({'id', 'created'} if name == 'bridge' else set())
        require(without(old, omitted) == without(new, omitted))
        previous = old['members'] or {}; current = new['members'] or {}
        require(previous.keys() == current.keys())
        for ident, member in previous.items():
            require(member.keys() == current[ident].keys())
            for field in ['IPv4Address', 'IPv6Address']:
                previous_address = member.get(field, ''); current_address = current[ident].get(field, '')
                require(bool(previous_address) == bool(current_address))
                if previous_address:
                    require(ipaddress.ip_interface(previous_address).network.prefixlen == ipaddress.ip_interface(current_address).network.prefixlen)
            require(without(member, {'EndpointID', 'MacAddress', 'IPv4Address', 'IPv6Address'}) == without(current[ident], {'EndpointID', 'MacAddress', 'IPv4Address', 'IPv6Address'}))


RECOVERY = ACTION / 'reboot-recovery'
import time


def pins():
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    daemon = run(['systemctl', 'show', 'docker.service', '--property=InvocationID', '--value'])
    require(re.fullmatch('[a-f0-9-]{36}', boot) and re.fullmatch('[a-f0-9]{32}', daemon))
    return {'boot': boot, 'daemon': daemon}


def config():
    result = {}
    for line in protected(FIXTURE / 'config/operations.env')[0].decode('ascii').splitlines():
        if not line or line.startswith('#'): continue
        key, value = line.split('=', 1); require(key not in result); result[key] = value
    require(result['FCD_RUNTIME_PROJECT'] == PROJECT and result['FCD_SUPPORT_REVISION'] == REV)
    require(result['FCD_STATE_ROOT'] == str(FIXTURE / 'state'))
    return result


def admin():
    ids = run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--filter', 'label=com.docker.compose.service=fcd-support-admin']).splitlines()
    require(len(ids) == 1)
    actor = json.loads(run(['docker', 'inspect', ids[0]]))[0]
    require(actor['Config']['Labels']['org.opencontainers.image.revision'] == REV)
    require(actor['HostConfig']['ReadonlyRootfs'] and not actor['HostConfig']['PortBindings'])
    expected = json.loads(run(['docker', 'image', 'inspect', config()['FCD_SUPPORT_IMAGE']]))[0]
    require(actor['Image'] == expected['Id'] and expected['Config']['Labels']['org.opencontainers.image.revision'] == REV)
    return actor


def definition(actor):
    return {'id': actor['Id'], 'image': actor['Image'], 'user': actor['Config']['User'], 'labels': actor['Config']['Labels'], 'command': actor['Config']['Cmd'], 'entrypoint': actor['Config']['Entrypoint'], 'mounts': sorted(actor['Mounts'], key=lambda v: json.dumps(v, sort_keys=True)), 'readonly': actor['HostConfig']['ReadonlyRootfs'], 'ports': actor['HostConfig']['PortBindings'], 'restart': actor['HostConfig']['RestartPolicy'], 'networks': sorted(actor['NetworkSettings']['Networks'])}


def bindings():
    # Bind secrets by inode/owner/mode/size/mtime/ctime without reading them.
    # The two PostgreSQL password files intentionally belong to UID 999.
    result = {}
    root = FIXTURE / 'secrets'
    for directory, children, files in os.walk(root, followlinks=False):
        parent = Path(directory); require(parent.resolve(strict=True) == parent)
        info = parent.lstat(); require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o700))
        for name in children + files:
            path = parent / name; require(not path.is_symlink() and path.resolve(strict=True) == path)
        for name in files:
            path = parent / name; info = path.lstat()
            owner = 999 if path.relative_to(root).as_posix() in ['postgres/postgres-password', 'restore/restore-postgres-password'] else 1000
            require(stat.S_ISREG(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_nlink) == (owner, owner, 0o600, 1))
            result[str(path)] = [info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_size, info.st_mtime_ns, info.st_ctime_ns]
    directory = FIXTURE / 'config'; require(directory.resolve(strict=True) == directory and not directory.is_symlink())
    paths = sorted(directory.iterdir()) + [FIXTURE / 'state/deployment-state', FIXTURE / ('state/retained-' + REV + '.record')]
    paths += sorted((FIXTURE / 'state').glob('restore-*.record'))
    paths += [ACTION / ('restore-drill/' + name) for name in ['source-selection.original', 'promoted-selection', 'restore-completed', 'promote-completed']]
    result.update({str(path): protected(path)[1] for path in paths})
    require(6 <= len(result) <= 200)
    return result


def immutable_bindings(value):
    return {key: item for key, item in value.items() if key != str(FIXTURE / 'state/deployment-state')}


def preserved_policies(baseline):
    actors = {actor['id']: actor for actor in baseline['actors']}
    lines = run(['docker', 'inspect', '--format', '{{.Id}}|{{json .HostConfig.RestartPolicy}}', *sorted(actors)]).splitlines()
    policies = {}
    for line in lines:
        ident, value = line.split('|', 1); require(ident in actors and ident not in policies); policies[ident] = json.loads(value)
    require(policies.keys() == actors.keys())
    for project in ['fcd-support-restore-host-test-p6-b0ba255', 'fcd-support-restore-host-test-p6-8ccb9a0-r2', 'fcd-support-restore-host-test-p6-6faff8b']:
        ids = run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project, '--filter', 'label=com.docker.compose.service=postgres']).splitlines()
        require(len(ids) == 1 and ids[0] in actors)
        require(actors[ids[0]]['state'] == 'exited' and policies[ids[0]] == {'Name': 'no', 'MaximumRetryCount': 0})
    return policies


def fresh(healthy=False, same_selection=True):
    require(run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']) == REV and not run(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '--untracked-files=all']))
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'))
    context = run(['docker', 'context', 'show'])
    require(run(['docker', 'context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}', context]) == 'unix:///var/run/docker.sock')
    current = fields(FIXTURE / 'state/deployment-state'); saved = fields(ACTION / 'restore-drill/promoted-selection'); original = fields(ACTION / 'restore-drill/source-selection.original')
    require(current['STATE_PHASE'] == 'ready' and current['STATE_REVISION'] == REV and current['STATE_WRITES_POSSIBLE'] == 'yes')
    require(not os.path.lexists(FIXTURE / 'state/active-job') and not list((FIXTURE / 'state').glob('active-job-*.next')) and not os.path.lexists(FIXTURE / 'state/deployment-state.next'))
    require(not os.path.lexists(ACTION / 'restore-drill/rollback-started'))
    if same_selection: require(current == saved)
    for key in ['STATE_VOLUME', 'STATE_SYSTEM_IDENTIFIER', 'STATE_RESTORE_REF']:
        require(current[key] == saved[key])
    require(current['STATE_VOLUME'] == TARGET + '-data' and current['STATE_PREVIOUS_VOLUME'] == original['STATE_VOLUME'] and current['STATE_SYSTEM_IDENTIFIER'] != original['STATE_SYSTEM_IDENTIFIER'])
    require(protected(ACTION / 'restore-drill/promote-completed')[0] == b'completed\n' and protected(ACTION / 'restore-drill/restore-completed')[0] == b'completed\n')
    records = list((FIXTURE / 'state').glob('restore-*.record')); require(len(records) == 1 and fields(records[0])['RESTORE_PHASE'] == 'completed')
    bundle = fields(FIXTURE / ('state/retained-' + REV + '.record'))
    require(bundle['BUNDLE_REVISION'] == REV and bundle['BUNDLE_PROJECT'] == PROJECT and bundle['BUNDLE_SCHEMA_REVISION'] == current['STATE_SCHEMA_REVISION'])
    for name in [original['STATE_VOLUME'], current['STATE_VOLUME']]: require(run(['docker', 'volume', 'inspect', '--format', '{{.Name}}', name]) == name)
    ids = run(['docker', 'ps', '--all', '--quiet', '--filter', 'label=com.docker.compose.project=' + PROJECT]).splitlines(); require(len(ids) == 4)
    actors = json.loads(run(['docker', 'inspect', *ids])); require({a['Config']['Labels']['com.docker.compose.service'] for a in actors} == {'postgres', 'fcd-support-api', 'fcd-support-admin', 'fcd-support-reply'})
    for actor in actors:
        require(actor['HostConfig']['ReadonlyRootfs'] and not actor['HostConfig']['PortBindings'] and actor['Config']['User'] not in ['', '0', 'root', '0:0'])
        role = actor['Config']['Labels']['com.docker.compose.service']
        if healthy or role != 'fcd-support-admin': require(actor['State']['Running'] and actor['State']['Health']['Status'] == 'healthy')
        if role == 'postgres': require([m['Name'] for m in actor['Mounts'] if m['Type'] == 'volume'] == [current['STATE_VOLUME']])
    return current


def socket_probe():
    import socket
    root = Path(config()['FCD_ADMIN_SOCKET_ROOT']); require(root.resolve(strict=True) == root and root.is_relative_to(FIXTURE) and root != FIXTURE)
    directory = root.lstat(); require(stat.S_ISDIR(directory.st_mode) and (directory.st_uid, directory.st_gid, stat.S_IMODE(directory.st_mode)) == (1000, 1000, 0o700))
    path = root / 'admin.sock'; entry = path.lstat()
    require(stat.S_ISSOCK(entry.st_mode) and (entry.st_uid, entry.st_gid, stat.S_IMODE(entry.st_mode), entry.st_nlink) == (1000, 1000, 0o600, 1))
    client = socket.socket(socket.AF_UNIX); client.settimeout(2)
    refused = False
    try: client.connect(str(path))
    except ConnectionRefusedError: refused = True
    finally: client.close()
    require(refused and path.lstat().st_ino == entry.st_ino and path.lstat().st_dev == entry.st_dev)
    return [entry.st_dev, entry.st_ino]


def initial():
    global STAGE
    STAGE = 'read_only_admission'
    require(os.getuid() == 1000 and os.getgid() == 1000 and not os.path.lexists(RECOVERY))
    parent = ACTION.lstat(); require(ACTION.resolve(strict=True) == ACTION and stat.S_ISDIR(parent.st_mode) and (parent.st_uid, parent.st_gid, stat.S_IMODE(parent.st_mode)) == (1000, 1000, 0o700))
    identity = pins(); old, metadata = protected(ACTION / 'preserved-baseline.json'); baseline = json.loads(old)
    current = snapshot(); reboot_compatible(baseline, current); assert_admission(current); stable(current)
    # Admission is tied to this observed cross-boot journal, not arbitrary drift.
    uptime = float(Path('/proc/uptime').read_text().split()[0])
    require((ACTION / 'preserved-baseline.json').stat().st_mtime < time.time() - uptime)
    records = [json.loads(line) for line in run(['journalctl', '-u', 'docker.service', '--since', '@' + str(int((ACTION / 'preserved-baseline.json').stat().st_mtime) - 30), '--output=json', '--no-pager', '-n', '2000']).splitlines() if line.startswith('{')]
    require(len({r.get('_BOOT_ID') for r in records if r.get('_BOOT_ID')}) == 2)
    require(any(r.get('_BOOT_ID') == identity['boot'].replace('-', '') and 'Daemon has completed initialization' in str(r.get('MESSAGE', '')) for r in records))
    fresh(); actor = admin(); require(actor['State']['Status'] == 'restarting' and actor['State']['Health']['Status'] == 'unhealthy')
    inode = socket_probe(); bound = bindings(); policies = preserved_policies(current); require(pins() == identity)
    return {'policies': policies, 'pins': identity, 'oldBaselineMetadata': metadata, 'preserved': current, 'bindings': bound, 'admin': definition(actor), 'socket': inode}


def write_new(name, value):
    path = RECOVERY / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(value); output.flush(); os.fsync(output.fileno())
    descriptor = os.open(RECOVERY, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def saved():
    for directory in [ACTION, RECOVERY]:
        info = directory.lstat(); require(directory.resolve(strict=True) == directory and stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o700))
    record = json.loads(protected(RECOVERY / 'current-baseline.json', 1048576)[0])
    require(pins() == record['pins'] and protected(ACTION / 'preserved-baseline.json')[1] == record['oldBaselineMetadata'])
    assert_admission(record['preserved']); stable(record['preserved'])
    require(preserved_policies(record['preserved']) == record['policies'])
    return record


def locked(callback):
    path = FIXTURE / 'state/deployment.lock'; protected(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        callback()
    finally: os.close(descriptor)


def command(args, name, timeout=2400):
    descriptor = os.open(RECOVERY / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        result = subprocess.run(args, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        output.flush(); os.fsync(output.fileno())
    require(result.returncode == 0)


def create_recovery():
    os.umask(0o077); RECOVERY.mkdir(mode=0o700)
    descriptor = os.open(ACTION, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


# Peer-only continuation. The prior failed recovery and its baseline stay immutable.
PEER_ACTION = ACTION / 'peer-recovery'


def peer():
    ident = config()['FCD_INGRESS_PEER_ID']; require(re.fullmatch('[a-f0-9]{64}', ident))
    actor = json.loads(run(['docker', 'inspect', ident]))[0]
    require(actor['Name'] == '/' + PROJECT + '-ingress-peer' and actor['Id'] == ident)
    image = json.loads(run(['docker', 'image', 'inspect', actor['Image']]))[0]
    require(actor['Config']['Env'] == image['Config']['Env'])
    require(actor['Image'] == admin()['Image'] and actor['Config']['Labels'].get('fcd-support.synthetic-host-test') == PROJECT and actor['Config']['Labels'].get('org.opencontainers.image.revision') == REV)
    require(actor['Config']['User'] == 'node' and actor['Config']['Entrypoint'] == ['node'] and actor['Config']['Cmd'] == ['-e', 'setInterval(()=>{},1000)'])
    host = actor['HostConfig']
    require(not host['Binds'] and not host['VolumesFrom'] and not host['Links'] and not host['Devices'] and not host['DeviceRequests'] and not host['CapAdd'])
    require(host['PidMode'] == '' and host['IpcMode'] == 'private' and host['UTSMode'] == '')
    require(not actor['Mounts'] and not host['PortBindings'] and host['ReadonlyRootfs'] and not host['Privileged'] and host['CapDrop'] == ['ALL'])
    require(host['SecurityOpt'] in [['no-new-privileges'], ['no-new-privileges:true']] and host['Init'] is True)
    require(host['NanoCpus'] == 250000000 and host['Memory'] == 134217728 and host['PidsLimit'] == 32)
    require(host['RestartPolicy'] == {'Name': 'no', 'MaximumRetryCount': 0} and host['NetworkMode'] == PROJECT + '-ingress')
    require(set(actor['NetworkSettings']['Networks']) == {PROJECT + '-ingress', PROJECT + '-egress'})
    return actor


def peer_definition(actor):
    result = definition(actor); networks = {}
    for name, endpoint in sorted(actor['NetworkSettings']['Networks'].items()):
        network = json.loads(run(['docker', 'network', 'inspect', endpoint['NetworkID']]))[0]
        ingress = name == PROJECT + '-ingress'
        require(network['Id'] == endpoint['NetworkID'] and network['Name'] == name and network['Driver'] == 'bridge' and network['Internal'] is ingress)
        require(network['Labels'].get('fcd-support.synthetic-host-test') == PROJECT)
        require(network['IPAM']['Driver'] == 'default' and len(network['IPAM']['Config']) == 1 and network['IPAM']['Config'][0]['Subnet'] == ('198.19.6.0/24' if ingress else '198.19.7.0/24'))
        networks[name] = {key: value for key, value in network.items() if key != 'Containers'}
    result['networkIdentities'] = networks
    return result


def peer_initial():
    require(not os.path.lexists(PEER_ACTION))
    record = saved(); fresh(healthy=True); require(bindings() == record['bindings'] and definition(admin()) == record['admin'])
    require(protected(RECOVERY / 'socket-recovery.log')[0] == b'admin_socket_recovered\n')
    require(protected(RECOVERY / 'recovered-verify.log')[0] == b'operations_verification_refused\n')
    require(not os.path.lexists(RECOVERY / 'recovery-completed') and not os.path.lexists(RECOVERY / 'rollback-started'))
    actor = peer(); require(actor['State']['Status'] == 'exited' and not actor['State']['Running'] and not actor['State']['Restarting'] and not actor['State']['Paused'] and not actor['State']['Dead'])
    return {'source': protected(RECOVERY / 'current-baseline.json', 1048576)[1], 'peer': peer_definition(actor)}


def peer_saved():
    info = PEER_ACTION.lstat(); require(PEER_ACTION.resolve(strict=True) == PEER_ACTION and stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o700))
    record = json.loads(protected(PEER_ACTION / 'admission.json')[0]); require(protected(RECOVERY / 'current-baseline.json', 1048576)[1] == record['source'])
    previous = saved(); require(immutable_bindings(bindings()) == immutable_bindings(previous['bindings']) and peer_definition(peer()) == record['peer'])
    return previous, record


def peer_create():
    os.umask(0o077); PEER_ACTION.mkdir(mode=0o700)
    descriptor = os.open(ACTION, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def peer_write(name, value):
    descriptor = os.open(PEER_ACTION / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(value); output.flush(); os.fsync(output.fileno())
    descriptor = os.open(PEER_ACTION, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def peer_command(args, name, timeout=2400):
    descriptor = os.open(PEER_ACTION / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        result = subprocess.run(args, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        output.flush(); os.fsync(output.fileno())
    require(result.returncode == 0)


def main():
    global STAGE
    require(len(sys.argv) == 2 and sys.argv[1] in ['--inspect', '--recover', '--rollback', '--audit'])
    mode = sys.argv[1]
    if mode in ['--inspect', '--recover']:
        STAGE = 'peer_read_only_admission'; record = peer_initial(); print('fresh_peer_recovery_read_only_admission=true', flush=True)
        if mode == '--inspect': return
        peer_create(); peer_write('admission.json', json.dumps(record, sort_keys=True).encode()); peer_write('recovery-started', b'started\n')
        def start():
            global STAGE
            STAGE = 'start_exact_synthetic_peer'; previous, saved_peer = peer_saved(); fresh(healthy=True)
            require(bindings() == previous['bindings'] and definition(admin()) == previous['admin'])
            actor = peer(); require(peer_definition(actor) == saved_peer['peer'] and actor['State']['Status'] == 'exited' and not actor['State']['Running'] and not actor['State']['Restarting'])
            peer_command(['docker', 'container', 'start', actor['Id']], 'peer-start.log', 30)
            actor = peer(); require(peer_definition(actor) == saved_peer['peer'] and actor['State']['Status'] == 'running' and actor['State']['Running'] and not actor['State']['Restarting'])
        locked(start)
        peer_saved(); fresh(healthy=True)
        STAGE = 'peer_recovered_public_verify'; peer_command(['bash', str(ROOT / 'scripts/verify-runtime.sh'), REV, str(FIXTURE / 'config/operations.env')], 'runtime-verify.log')
        previous, record = peer_saved(); fresh(healthy=True); require(bindings() == previous['bindings'] and definition(admin()) == previous['admin'])
        require(peer()['State']['Running']); peer_write('runtime-completed', b'completed\n'); print('fresh_peer_runtime_public_verification_passed=true', flush=True); return
    previous, record = peer_saved(); require(protected(PEER_ACTION / 'runtime-completed')[0] == b'completed\n' and peer()['State']['Running'])
    if mode == '--audit':
        fresh(healthy=True, same_selection=not os.path.lexists(PEER_ACTION / 'rollback-completed'))
        print('fresh_peer_preservation_audit_passed=true', flush=True); return
    STAGE = 'peer_rollback_admission'; require(not os.path.lexists(PEER_ACTION / 'rollback-started'))
    fresh(healthy=True); require(bindings() == previous['bindings'])
    peer_command(['bash', str(ROOT / 'scripts/verify-runtime.sh'), REV, str(FIXTURE / 'config/operations.env')], 'pre-rollback-verify.log')
    peer_saved(); fresh(healthy=True); require(bindings() == previous['bindings']); peer_write('rollback-started', b'started\n')
    STAGE = 'peer_public_retained_rollback'
    peer_command(['bash', str(ROOT / 'scripts/rollback-runtime.sh'), REV, '--confirm-schema-compatible', str(FIXTURE / 'config/operations.env')], 'rollback.log')
    STAGE = 'peer_rollback_public_verify'
    peer_command(['bash', str(ROOT / 'scripts/verify-runtime.sh'), REV, str(FIXTURE / 'config/operations.env')], 'rollback-verify.log')
    peer_saved(); fresh(healthy=True, same_selection=False); require(peer()['State']['Running'])
    peer_write('rollback-completed', b'completed\n'); print('fresh_peer_retained_rollback_verified=true', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('fresh_peer_recovery_refused_stage=' + STAGE, flush=True)
        raise SystemExit(1)
