# Second-boot repair of only the current fcd-support admin and inert canary.
# Older missing actors stay absent/quarantined; no SQL operation is replayed.
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

REV = '67a4a4bede6d3252dc936a6e410f4b90c1359ac3'
ROOT = Path('/home/redwan/apps/fcd-support')
PROJECT = 'fcd-support-host-test-p6-67a4a4b'
TARGET = 'fcd-support-restore-host-test-p6-67a4a4b'
FIXTURE = Path('/home/redwan') / PROJECT
ACTION = Path('/home/redwan/fcd-support-p6-action-67a4a4b')
RECOVERY = ACTION / 'reboot-recovery'
PEER_ACTION = ACTION / 'peer-recovery'
ROLLBACK_ACTION = ACTION / 'rollback-after-reboot'
CURRENT = ACTION / 'second-boot-recovery'
ADMISSION = ['fcd-support-fcd-support-api-1', 'fcd-support-postgres-1', 'fcd-support-cloudflared']
STAGE = 'arguments'


def run(args, timeout=30):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    require(result.returncode == 0 and len(result.stdout) <= 2097152)
    return result.stdout.strip()


def require(value):
    if not value:
        raise RuntimeError('refused')


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


def peer_started_transition(before, after):
    require(before.keys() == after.keys())
    require({k: v for k, v in before.items() if k != 'networkIdentities'} == {k: v for k, v in after.items() if k != 'networkIdentities'})
    old_networks = before['networkIdentities']; new_networks = after['networkIdentities']
    require(old_networks.keys() == new_networks.keys() and len(old_networks) == 2)
    for name, old in old_networks.items():
        new = new_networks[name]; require(old.keys() == new.keys())
        require({k: v for k, v in old.items() if k != 'Status'} == {k: v for k, v in new.items() if k != 'Status'})
        previous = old['Status']; current = new['Status']
        require(isinstance(previous, dict) and isinstance(current, dict) and previous.keys() == current.keys() == {'IPAM'})
        previous = previous['IPAM']; current = current['IPAM']
        require(isinstance(previous, dict) and isinstance(current, dict) and previous.keys() == current.keys() == {'Subnets'})
        previous = previous['Subnets']; current = current['Subnets']
        require(isinstance(previous, dict) and isinstance(current, dict) and previous.keys() == current.keys() and len(previous) == 1)
        require(list(previous) == [old['IPAM']['Config'][0]['Subnet']])
        for subnet, counts in previous.items():
            observed = current[subnet]
            require(isinstance(counts, dict) and isinstance(observed, dict) and counts.keys() == observed.keys() == {'IPsInUse', 'DynamicIPsAvailable'})
            require(all(type(value) is int and value >= 0 for value in [*counts.values(), *observed.values()]))
            require(observed['IPsInUse'] == counts['IPsInUse'] + 1 and observed['DynamicIPsAvailable'] == counts['DynamicIPsAvailable'] - 1)


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


def post_restart_quarantine(before, after):
    old = {a['id']: a for a in before['actors']}; current = {a['id']: a for a in after['actors']}
    require(len(old) == len(before['actors']) and len(current) == len(after['actors']) and current.keys() <= old.keys())
    missing = sorted(old.keys() - current.keys())
    require(len(missing) == 7 and all(old[ident]['state'] == 'exited' for ident in missing))
    filtered = {**before, 'actors': [a for a in before['actors'] if a['id'] not in missing]}
    reboot_compatible(filtered, after)
    return missing


def other_projects():
    inventory = run(['docker','ps','--all','--no-trunc','--format','{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "fcd-support.synthetic-host-test"}}|{{.Label "fcd-support.operation.parent"}}|{{.Label "fcd-support.socket-recovery"}}']).splitlines()
    require(1 <= len(inventory) <= 1000)
    ids = []
    for line in inventory:
        ident, *owners = line.split('|'); require(len(owners) == 4 and re.fullmatch('[a-f0-9]{64}', ident))
        if not any(owner in [PROJECT, TARGET] for owner in owners): ids.append(ident)
    require(ids)
    shape = '{"id":{{json .Id}},"image":{{json .Image}},"user":{{json .Config.User}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"ports":{{json .HostConfig.PortBindings}},"state":{{json .State.Status}},"started":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"policy":{{json .HostConfig.RestartPolicy}},"health":{{with index .State "Health"}}{{json (index . "Status")}}{{else}}"none"{{end}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}}}'
    actors = [json.loads(line) for line in run(['docker','inspect','--format',shape,*sorted(ids)]).splitlines()]
    for actor in actors: actor['mounts'] = sorted(actor['mounts'], key=lambda value: json.dumps(value,sort_keys=True))
    network_ids = run(['docker','network','ls','--quiet','--no-trunc']).splitlines(); require(1 <= len(network_ids) <= 1000)
    shape = '{"id":{{json .Id}},"created":{{json .Created}},"driver":{{json .Driver}},"internal":{{json .Internal}},"ipam":{{json .IPAM}},"members":{{json .Containers}},"owner":{{json (index .Labels "fcd-support.synthetic-host-test")}},"compose":{{json (index .Labels "com.docker.compose.project")}}}'
    networks = [json.loads(line) for line in run(['docker','network','inspect','--format',shape,*sorted(network_ids)]).splitlines()]
    networks = [n for n in networks if n['owner'] not in [PROJECT,TARGET] and n['compose'] not in [PROJECT,TARGET]]
    volume_ids = run(['docker','volume','ls','--quiet']).splitlines(); require(1 <= len(volume_ids) <= 2000)
    shape = '{"name":{{json .Name}},"created":{{json .CreatedAt}},"driver":{{json .Driver}},"scope":{{json .Scope}}}'
    volumes = [json.loads(line) for line in run(['docker','volume','inspect','--format',shape,*sorted(volume_ids)]).splitlines()]
    # Persist digests of operational metadata, never another project's env,
    # arguments, labels, driver credentials, raw metadata or customer content.
    def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'actors': digest(actors), 'actorCount': len(actors), 'networks': digest(networks), 'networkCount': len(networks), 'volumes': digest(volumes), 'volumeCount': len(volumes)}


def current_policies(actors):
    ids = sorted(actor['id'] for actor in actors)
    result = {}
    for line in run(['docker','inspect','--format','{{.Id}}|{{json .HostConfig.RestartPolicy}}',*ids]).splitlines():
        ident, value = line.split('|',1); require(ident in ids and ident not in result); result[ident] = json.loads(value)
    require(set(result) == set(ids)); return result


def historical_evidence():
    paths = [ACTION/'preserved-baseline.json', RECOVERY/'current-baseline.json', RECOVERY/'socket-recovery.log', RECOVERY/'recovered-verify.log', PEER_ACTION/'admission.json', PEER_ACTION/'peer-start.log', ROLLBACK_ACTION/'current-proof.json', ROLLBACK_ACTION/'rollback-completed']
    require(protected(ROLLBACK_ACTION/'rollback-completed')[0] == b'completed\n')
    require(not os.path.lexists(RECOVERY/'recovery-completed') and not os.path.lexists(PEER_ACTION/'runtime-completed'))
    return {str(path): protected(path,1048576)[1] for path in paths}


def control_identity():
    ids = run(['docker','ps','--all','--quiet','--filter','label=com.docker.compose.project='+PROJECT,'--filter','label=com.docker.compose.service=postgres']).splitlines(); require(len(ids)==1)
    text = run(['docker','exec','--user','999:999',ids[0],'pg_controldata'])
    match = re.search(r'^Database system identifier:\s+([0-9]+)\s*$',text,re.M)
    require(match and match.group(1)==fields(FIXTURE/'state/deployment-state')['STATE_SYSTEM_IDENTIFIER'])


def initial():
    global STAGE
    STAGE = 'read_only_current_admission'; require(not os.path.lexists(CURRENT))
    require(os.getuid()==1000 and os.getgid()==1000)
    for directory in [ACTION,RECOVERY,PEER_ACTION,ROLLBACK_ACTION]:
        info=directory.lstat(); require(directory.resolve(strict=True)==directory and stat.S_ISDIR(info.st_mode) and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(1000,1000,0o700))
    historic=json.loads(protected(RECOVERY/'current-baseline.json',1048576)[0]); identity=pins()
    require(identity['boot']!=historic['pins']['boot'] and identity['daemon']!=historic['pins']['daemon'])
    old=snapshot(); missing=post_restart_quarantine(historic['preserved'],old); assert_admission(old)
    policies=current_policies(old['actors']); require(policies=={ident:value for ident,value in historic['policies'].items() if ident not in missing})
    fresh(same_selection=False); control_identity()
    proof=json.loads(protected(ROLLBACK_ACTION/'current-proof.json',1048576)[0]); require(immutable_bindings(bindings())==immutable_bindings(proof['bindings']))
    actor=admin(); require(actor['State']['Status']=='restarting' and actor['State']['Health']['Status']=='unhealthy')
    socket=socket_probe(); canary=peer(); require(canary['State']['Status']=='exited' and not canary['State']['Running'] and not canary['State']['Restarting'])
    others=other_projects(); require(snapshot()==old and other_projects()==others and pins()==identity)
    return {'pins':identity,'oldCurrent':old,'missingQuarantinedActors':missing,'policies':policies,'others':others,'evidence':historical_evidence(),'bindings':bindings(),'admin':definition(actor),'socket':socket,'peerBefore':peer_definition(canary)}


def preserve(record):
    require(pins()==record['pins'] and snapshot()==record['oldCurrent'] and other_projects()==record['others'])
    require(current_policies(record['oldCurrent']['actors'])==record['policies'])
    require(historical_evidence()==record['evidence'] and bindings()==record['bindings'])
    assert_admission(record['oldCurrent']); fresh(same_selection=False); control_identity()
    require(not run(['docker','ps','--quiet','--filter','label=fcd-support.operation.parent']))


def create_current():
    os.umask(0o077); CURRENT.mkdir(mode=0o700)
    descriptor=os.open(ACTION,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def write_current(name,value):
    descriptor=os.open(CURRENT/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'wb') as output:output.write(value);output.flush();os.fsync(output.fileno())
    descriptor=os.open(CURRENT,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def command(args,name,timeout=2400):
    descriptor=os.open(CURRENT/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'wb') as output:
        result=subprocess.run(args,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,timeout=timeout);output.flush();os.fsync(output.fileno())
    require(result.returncode==0)


def locked(callback):
    path=FIXTURE/'state/deployment.lock';protected(path);descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB);callback()
    finally:os.close(descriptor)


def main():
    global STAGE
    require(len(sys.argv)==2 and sys.argv[1] in ['--inspect','--execute','--audit'])
    mode=sys.argv[1]
    if mode=='--audit':
        info=CURRENT.lstat();require(CURRENT.resolve(strict=True)==CURRENT and stat.S_ISDIR(info.st_mode) and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(1000,1000,0o700))
        require(protected(CURRENT/'readiness-completed')[0]==b'completed\n')
        record=json.loads(protected(CURRENT/'current-baseline.json',1048576)[0]);preserve(record);fresh(healthy=True,same_selection=False)
        require(definition(admin())==record['admin'] and peer()['State']['Running']);peer_started_transition(record['peerBefore'],peer_definition(peer()))
        print('current_fcd_recovery_audit_passed=true',flush=True);return
    record=initial();print('current_fcd_recovery_read_only_admission=true',flush=True)
    if mode=='--inspect':return
    create_current();write_current('current-baseline.json',json.dumps(record,sort_keys=True).encode());write_current('recovery-started',b'started\n')
    def stop_admin():
        global STAGE
        STAGE='stop_only_current_admin';preserve(record);actor=admin();require(definition(actor)==record['admin'] and socket_probe()==record['socket'])
        grace=config()['FCD_STOP_GRACE_MS'];require(grace.isdigit() and 1<=int(grace)<=300000)
        command(['docker','container','stop','--time',str((int(grace)+999)//1000),actor['Id']],'admin-stop.log',(int(grace)+999)//1000+30)
        actor=admin();require(definition(actor)==record['admin'] and actor['State']['Status']=='exited' and not actor['State']['Running'] and not actor['State']['Restarting'])
    locked(stop_admin)
    STAGE='public_current_socket_recovery';preserve(record)
    command(['bash',str(ROOT/'scripts/recover-admin-socket.sh'),REV,'--confirm-admin-stopped',str(FIXTURE/'config/operations.env')],'socket-recovery.log')
    require(protected(CURRENT/'socket-recovery.log')[0]==b'admin_socket_recovered\n')
    def start_admin():
        global STAGE
        STAGE='start_same_current_admin';preserve(record);actor=admin();require(definition(actor)==record['admin'] and actor['State']['Status']=='exited' and not actor['State']['Running'] and not actor['State']['Restarting'])
        require(not os.path.lexists(Path(config()['FCD_ADMIN_SOCKET_ROOT'])/'admin.sock'))
        command(['docker','container','start',actor['Id']],'admin-start.log',30)
    locked(start_admin)
    STAGE='current_admin_health';bound=config()['FCD_READY_TIMEOUT_SECONDS'];require(bound.isdigit() and 1<=int(bound)<=3600);deadline=time.monotonic()+int(bound)
    while True:
        require(pins()==record['pins']);actor=admin();require(definition(actor)==record['admin'])
        if actor['State']['Running'] and actor['State']['Health']['Status']=='healthy':break
        require(time.monotonic()<deadline);time.sleep(0.2)
    def start_peer():
        global STAGE
        STAGE='start_same_current_canary';preserve(record);fresh(healthy=True,same_selection=False);canary=peer();require(peer_definition(canary)==record['peerBefore'] and canary['State']['Status']=='exited' and not canary['State']['Running'] and not canary['State']['Restarting'])
        command(['docker','container','start',canary['Id']],'canary-start.log',30)
        canary=peer();require(canary['State']['Status']=='running' and canary['State']['Running']);peer_started_transition(record['peerBefore'],peer_definition(canary))
    locked(start_peer);preserve(record)
    STAGE='current_public_verification';command(['bash',str(ROOT/'scripts/verify-runtime.sh'),REV,str(FIXTURE/'config/operations.env')],'runtime-verify.log')
    preserve(record);fresh(healthy=True,same_selection=False);require(definition(admin())==record['admin'] and peer()['State']['Running']);peer_started_transition(record['peerBefore'],peer_definition(peer()))
    write_current('readiness-completed',b'completed\n');print('current_fcd_private_readiness_verified=true',flush=True)


if __name__=='__main__':
    try:main()
    except Exception:
        print('current_fcd_recovery_refused_stage='+STAGE,flush=True)
        raise SystemExit(1)
