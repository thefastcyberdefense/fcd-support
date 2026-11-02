"""Fresh Task 16 attempt; preserve the prior uncertain scope and original baseline."""

import copy
import ipaddress
import re
import hashlib
import json
import os
import posixpath
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path('/home/redwan/apps/fcd-support')
HOME = Path('/home/redwan')
# PR #6 mainline merge has the exact validated e665249 tree.
VALIDATED = '7af70cc77196813b92d8365567150153996b790a'
PRIOR_REVISION = '6d0210ddee6c333b6ce803370392a0818f5f3d29'
NETWORK_START = 48
NETWORK_BLOCK = '198.19.48.0/20'
NODE_IMAGE = 'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d'
UNITS = ['fcd-support-operation@.service', 'fcd-support-backup.timer', 'fcd-support-maintenance.timer', 'fcd-support-health.timer']
STAGE = 'arguments'


def require(value):
    if not value:
        raise RuntimeError('final_server_refused')


def source_scope(revision):
    require(isinstance(revision, str) and re.fullmatch('[a-f0-9]{40}', revision))
    return 'fcd-support-host-test-p6-' + revision[:7]


def network_free(proposed, existing):
    wanted = [ipaddress.ip_network(value) for value in proposed]
    present = [ipaddress.ip_network(value, strict=False) for value in existing]
    return all(not first.overlaps(second) for index, first in enumerate(wanted)
               for second in wanted[index + 1:] + present
               if first.version == second.version)


def network_cidrs():
    return ['198.19.' + str(NETWORK_START + index) + '.0/24' for index in range(8)]


def qualify_prior_loss(before, after, admin):
    """Qualify the observed single loss; never repair or replace its baseline."""
    first, second = copy.deepcopy(before), copy.deepcopy(after)
    ids = [[row['id'] for row in value['actors']] for value in [first, second]]
    require(all(len(values) == len(set(values)) for values in ids))
    missing = sorted(set(ids[0]) - set(ids[1]))
    require(len(missing) == 1 and not (set(ids[1]) - set(ids[0])))
    absent = next(row for row in first['actors'] if row['id'] == missing[0])
    definition = absent['static']
    require(absent['state'] == 'running' and absent['id'] != admin)
    require(not definition.get('synthetic') and not (definition.get('owner') or '').startswith('fcd-support'))
    require(not definition['name'].lstrip('/').startswith('fcd-support'))
    first['actors'] = [row for row in first['actors'] if row['id'] not in missing]
    for network in first['networks']:
        for ident in missing: network['members'].pop(ident, None)
    require(preserved(first, second, admin))
    return missing


def capture_admission(project, original, admin):
    before = snapshot(project, admin)
    missing = qualify_prior_loss(original, snapshot(source_scope(PRIOR_REVISION), admin), admin)
    assert_preserved(before, snapshot(project, admin), admin)
    return before, missing


def source_disjoint(paths):
    return all(posixpath.isabs(path) and posixpath.normpath(path) == path and
               posixpath.commonpath([ROOT.as_posix(), path]) not in [ROOT.as_posix(), path]
               for path in paths)


def preserved(before, after, restarting_admin):
    try:
        first, second = copy.deepcopy(before), copy.deepcopy(after)
        for snapshot in [first, second]:
            matching = [actor for actor in snapshot['actors'] if actor['id'] == restarting_admin]
            require(len(matching) == 1)
            actor = matching[0]
            require(actor['state'] in ['running', 'restarting'] and actor['health'] == 'unhealthy')
            require(type(actor['restarts']) is int and actor['restarts'] >= 0)
        a = next(actor for actor in first['actors'] if actor['id'] == restarting_admin)
        b = next(actor for actor in second['actors'] if actor['id'] == restarting_admin)
        require(b['restarts'] >= a['restarts'])
        for actor in [a, b]:
            actor.pop('restarts'); actor.pop('state')
        return first == second
    except (KeyError, IndexError, TypeError, RuntimeError, StopIteration):
        return False


def unit_admission(rows):
    return len(rows) == 4 and all(row == {'exists': False, 'load': 'not-found', 'fragment': ''} for row in rows)


def assert_preserved(before, after, admin):
    if preserved(before, after, admin): return
    for key in ['actors', 'networks', 'volumes', 'files', 'pins']:
        if before.get(key) != after.get(key): print('final_server_preservation_changed=' + key, flush=True)
    for snapshot in [before, after]:
        for actor in snapshot['actors']:
            if actor['id'] == admin:
                if actor['state'] in ['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead']:
                    print('final_server_old_admin_state=' + actor['state'], flush=True)
                if actor['health'] in ['none', 'starting', 'healthy', 'unhealthy']:
                    print('final_server_old_admin_health=' + actor['health'], flush=True)
    require(False)


def run(args, timeout=30):
    result = subprocess.run(args, cwd=ROOT, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    require(result.returncode == 0 and len(result.stdout) <= 4194304)
    return result.stdout.strip()


def checked_file(path, limit=1048576):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 1000 and before.st_gid == 1000 and stat.S_IMODE(before.st_mode) in [0o400, 0o600] and before.st_size <= limit)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno()); data = stream.read(limit + 1); after = os.fstat(stream.fileno())
    require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino))
    require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns) and len(data) == before.st_size)
    return data, [before.st_dev, before.st_ino, before.st_mtime_ns, hashlib.sha256(data).hexdigest()]


def private_directory(path):
    info = path.lstat()
    require(path.resolve(strict=True) == path and stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o700))


def new_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def pins():
    return {'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'daemon': run(['systemctl', 'show', 'docker.service', '-p', 'InvocationID', '--value'])}


def timer_rows():
    result = []
    for unit in UNITS:
        exists = any(os.path.lexists(Path(parent) / unit) for parent in ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system', '/run/systemd/system'])
        queries = ['fcd-support-operation@' + job + '.service' for job in ['backup', 'maintenance', 'health']] if '@.' in unit else [unit]
        loads = [run(['systemctl', 'show', query, '-p', 'LoadState', '--value']) for query in queries]
        fragments = [run(['systemctl', 'show', query, '-p', 'FragmentPath', '--value']) for query in queries]
        result.append({'exists': exists, 'load': 'not-found' if all(value == 'not-found' for value in loads) else 'loaded', 'fragment': '' if not any(fragments) else 'present'})
    return result


def snapshot(project, allowed_admin):
    ids = run(['docker', 'ps', '-aq', '--no-trunc']).splitlines()
    require(1 <= len(ids) <= 1000)
    shape = '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "com.docker.compose.project")}},"synthetic":{{json (index .Config.Labels "fcd-support.synthetic-host-test")}},"image":{{json .Image}},"user":{{json .Config.User}},"ro":{{json .HostConfig.ReadonlyRootfs}},"ports":{{json .HostConfig.PortBindings}},"policy":{{json .HostConfig.RestartPolicy}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"state":{{json .State.Status}},"health":{{with index .State "Health"}}{{json (index . "Status")}}{{else}}"none"{{end}},"restarts":{{json .RestartCount}},"started":{{json .State.StartedAt}}}'
    actors = []
    for line in run(['docker', 'inspect', '--format', shape, *sorted(ids)]).splitlines():
        row = json.loads(line)
        if row['owner'] == project or row['synthetic'] == project: continue
        dynamic = {key: row.pop(key) for key in ['state', 'health', 'restarts']}
        row['mounts'] = sorted(row['mounts'], key=lambda value: json.dumps(value, sort_keys=True))
        if row['id'] == allowed_admin:
            row.pop('started')
            row['networks'] = {name: {'Aliases': value.get('Aliases'), 'IPAMConfig': value.get('IPAMConfig')} for name, value in row['networks'].items()}
        actors.append({'id': row.pop('id'), 'static': row, **dynamic})
    networks = []
    for ident in run(['docker', 'network', 'ls', '-q']).splitlines():
        shape = '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"driver":{{json .Driver}},"internal":{{json .Internal}},"ipam":{{json .IPAM.Config}},"members":{{json .Containers}}}'
        row = json.loads(run(['docker', 'network', 'inspect', '--format', shape, ident]))
        if row['name'] in [project + '-' + role + ('-data' if index < 6 else '') for index, role in enumerate(['webhook', 'admin', 'reply', 'outbound', 'notification', 'operations', 'ingress', 'egress'])]: continue
        row['members'].pop(allowed_admin, None); networks.append(row)
    volumes = []
    for name in run(['docker', 'volume', 'ls', '-q']).splitlines():
        if name in [project + '-postgres', project + '-backups']: continue
        shape = '{"name":{{json .Name}},"created":{{json .CreatedAt}},"driver":{{json .Driver}},"scope":{{json .Scope}}}'
        volumes.append(json.loads(run(['docker', 'volume', 'inspect', '--format', shape, name])))
    files = {}
    for fixture in sorted(HOME.glob('fcd-support-host-test-p6-*')):
        if fixture.name == project or not (fixture / 'state').is_dir(): continue
        private_directory(fixture / 'state')
        for path in sorted((fixture / 'state').rglob('*')):
            if path.name == 'deployment.lock': continue
            if path.is_file(): files[str(path)] = checked_file(path)[1]
            else: private_directory(path)
    if project != source_scope(PRIOR_REVISION):
        previous = HOME / ('fcd-support-p6-final-' + PRIOR_REVISION[:7])
        private_directory(previous)
        for name in ['baseline.json', 'deployment-started', 'maintenance.log', 'backup.log', 'backup-replay.log']:
            path = previous / name
            files[str(path)] = checked_file(path, 4194304)[1]
    return {'actors': actors, 'networks': sorted(networks, key=lambda row: row['id']), 'volumes': sorted(volumes, key=lambda row: row['name']), 'files': files, 'pins': pins()}


def subnets():
    result = []
    for ident in run(['docker', 'network', 'ls', '-q']).splitlines():
        for row in json.loads(run(['docker', 'network', 'inspect', '--format', '{{json .IPAM.Config}}', ident])) or []:
            if row.get('Subnet'): result.append(row['Subnet'])
    for route in json.loads(run(['ip', '-4', '-json', 'route', 'show', 'table', 'all'])):
        if route.get('dst') not in [None, 'default']:
            result.append(str(ipaddress.ip_network(route['dst'], strict=False)))
    for interface in json.loads(run(['ip', '-4', '-json', 'addr', 'show'])):
        for address in interface.get('addr_info', []):
            if address.get('family') == 'inet':
                result.append(str(ipaddress.ip_network(address['local'] + '/' + str(address['prefixlen']), strict=False)))
    return result


def group_live(group):
    for path in Path('/proc').glob('[0-9]*/stat'):
        try: value = path.read_text()
        except (FileNotFoundError, ProcessLookupError): continue
        fields = value[value.rfind(')') + 2:].split()
        require(len(fields) >= 4)
        if int(fields[2]) == group and fields[0] != 'Z': return True
    return False


def drain_group(child):
    had_live_members = group_live(child.pid)
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        if not group_live(child.pid): break
        try: os.killpg(child.pid, sig)
        except ProcessLookupError: pass
        deadline = time.monotonic() + 5
        while group_live(child.pid) and time.monotonic() < deadline:
            child.poll(); time.sleep(0.03)
    require(not group_live(child.pid))
    child.wait(timeout=1)
    return had_live_members


def logged(args, path, timeout=2400, environment=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        child = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, env=environment, start_new_session=True)
        code = None
        try:
            code = child.wait(timeout=timeout)
        finally:
            unexpected_members = drain_group(child)
            stream.flush(); os.fsync(stream.fileno())
        require(code == 0 and not unexpected_members)


def main():
    import fcntl
    global STAGE
    require(len(sys.argv) == 3 and sys.argv[1] in ['--inspect', '--deploy', '--audit'])
    STAGE = 'read_only_platform'
    mode, revision = sys.argv[1:]; project = source_scope(revision)
    action = HOME / ('fcd-support-p6-final-' + revision[:7]); fixture = HOME / project
    require(os.getuid() == 1000 and os.getgid() == 1000 and ROOT.resolve(strict=True) == ROOT)
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'))
    require(run(['docker', 'context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}', run(['docker', 'context', 'show'])]) == 'unix:///var/run/docker.sock')
    require(run(['docker', 'info', '--format', '{{.DockerRootDir}}']) == '/var/lib/docker')
    require(not run(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '--untracked-files=all']))
    ids = run(['docker', 'ps', '-aq']).splitlines()
    require(1 <= len(ids) <= 1000)
    mounts = run(['docker', 'inspect', '--format', '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}', *ids]).splitlines()
    require(source_disjoint([str(Path(path).resolve(strict=True)) for path in mounts if path]))
    STAGE = 'quarantine_anchor'
    record_path = HOME / 'fcd-support-p6-action-67a4a4b/second-boot-recovery/current-baseline.json'
    historic = json.loads(checked_file(record_path)[0]); allowed_admin = historic['admin']['id']
    require(re.fullmatch('[a-f0-9]{64}', allowed_admin))
    locks = []
    try:
        STAGE = 'preservation_locks'
        for state in sorted(HOME.glob('fcd-support-host-test-p6-*/state')):
            if state.parent.name == project: continue
            checked_file(state / 'deployment.lock')
            fd = os.open(state / 'deployment.lock', os.O_RDONLY | os.O_NOFOLLOW)
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB); locks.append(fd)
        STAGE = 'prior_attempt_quarantine'
        prior = HOME / ('fcd-support-p6-final-' + PRIOR_REVISION[:7])
        private_directory(prior)
        require(checked_file(prior / 'deployment-started')[0] == (PRIOR_REVISION + '\n').encode())
        require(not os.path.lexists(prior / 'deployment-completed'))
        prior_fixture = HOME / source_scope(PRIOR_REVISION)
        job = dict(line.split('=', 1) for line in checked_file(prior_fixture / 'state/active-job')[0].decode().splitlines())
        require(job['JOB_PHASE'] == 'uncertain' and job['JOB_SERVICE'] == 'maintenance' and job['JOB_REVISION'] == PRIOR_REVISION)
        missing = None
        if mode != '--audit':
            original = json.loads(checked_file(prior / 'baseline.json', 4194304)[0])
            before, missing = capture_admission(project, original, allowed_admin)
        else:
            before = snapshot(project, allowed_admin)
        STAGE = 'preservation_observation'
        assert_preserved(before, snapshot(project, allowed_admin), allowed_admin)
        if mode == '--audit':
            private_directory(action)
            saved = json.loads(checked_file(action / 'baseline.json', 4194304)[0])
            qualification = json.loads(checked_file(action / 'prior-quarantine.json')[0])
            require(len(qualification['missing']) == 1 and qualification['originalBaseline'] == checked_file(prior / 'baseline.json', 4194304)[1])
            require(preserved(saved, before, allowed_admin) and checked_file(action / 'deployment-completed')[0] == b'completed\n')
            logged(['bash', 'scripts/verify-runtime.sh', revision, str(fixture / 'config/operations.env')], action / ('audit-' + uuid.uuid4().hex + '.log'))
            require(preserved(saved, snapshot(project, allowed_admin), allowed_admin))
            print('final_server_audit_passed=true'); return
        STAGE = 'fresh_admission'
        require(not os.path.lexists(action) and not os.path.lexists(fixture))
        STAGE = 'unit_absence'
        require(unit_admission(timer_rows()))
        STAGE = 'capacity'
        space = os.statvfs('/var/lib/docker'); require(space.f_bavail * space.f_frsize >= 12 * 1024**3)
        require(network_free([NETWORK_BLOCK], subnets()))
        STAGE = 'new_namespace_absence'
        names = run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
        require(not any(name.startswith(project) for name in names))
        for kind in ['network', 'volume', 'image']:
            values = run(['docker', kind, 'ls', '--format', '{{.Name}}' if kind != 'image' else '{{.Repository}}:{{.Tag}}']).splitlines()
            require(not any(value.startswith(project) for value in values))
        for name in ['fcd-support-fcd-support-api-1', 'fcd-support-postgres-1', 'fcd-support-cloudflared']:
            require(run(['docker', 'inspect', '--format', '{{.State.Running}}', name]) == 'true')
        STAGE = 'preservation_recheck'
        assert_preserved(before, snapshot(project, allowed_admin), allowed_admin)
        print('final_server_read_only_admission=true', flush=True)
        if mode == '--inspect': return
        os.umask(0o077); action.mkdir(mode=0o700); new_file(action / 'baseline.json', json.dumps(before, sort_keys=True).encode())
        new_file(action / 'prior-quarantine.json', json.dumps({'missing': missing, 'originalBaseline': checked_file(prior / 'baseline.json', 4194304)[1]}, sort_keys=True).encode())
        new_file(action / 'deployment-started', revision.encode() + b'\n')
        STAGE = 'source_checkout'
        logged(['git', 'fetch', '--no-tags', 'origin', 'main'], action / 'fetch.log', 120)
        run(['git', 'merge-base', '--is-ancestor', revision, 'origin/main'])
        run(['git', 'diff', '--quiet', VALIDATED, revision, '--', '.', ':(exclude)docs/**'])
        logged(['git', 'checkout', '--detach', revision], action / 'checkout.log', 30)
        require(run(['git', 'rev-parse', 'HEAD']) == revision)
        STAGE = 'private_node_toolchain'
        tools = action / 'tools'; tools.mkdir(mode=0o700)
        logged(['docker', 'pull', NODE_IMAGE], action / 'node-image.log', 180)
        helper = project + '-node-extract'
        ident = run(['docker', 'create', '--name', helper, '--network', 'none', '--read-only', '--user', 'node', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '0.25', '--memory', '128m', '--pids-limit', '32', '--label', 'fcd-support.synthetic-host-test=' + project, NODE_IMAGE, 'node', '--version'])
        require(re.fullmatch('[a-f0-9]{64}', ident))
        run(['docker', 'cp', ident + ':/usr/local/bin/node', str(tools / 'node')])
        require(run(['docker', 'inspect', '--format', '{{.State.Status}}/{{.HostConfig.NetworkMode}}/{{index .Config.Labels "fcd-support.synthetic-host-test"}}', ident]) == 'created/none/' + project)
        run(['docker', 'rm', ident]); os.chmod(tools / 'node', 0o555)
        require(run([str(tools / 'node'), '--version']) == 'v24.18.0')
        STAGE = 'dedicated_bridges'
        for index, role in enumerate(['webhook', 'admin', 'reply', 'outbound', 'notification', 'operations', 'ingress', 'egress']):
            cidr = network_cidrs()[index]; require(network_free([cidr], subnets()))
            name = project + '-' + role + ('-data' if index < 6 else '')
            args = ['docker', 'network', 'create', '--driver', 'bridge', '--subnet', cidr, '--label', 'fcd-support.synthetic-host-test=' + project]
            if role != 'egress': args.append('--internal')
            if index < 6: args += ['--label', 'com.docker.compose.project=' + project, '--label', 'com.docker.compose.network=' + role + '_data']
            require(re.fullmatch('[a-f0-9]{64}', run(args + [name])))
        require(preserved(before, snapshot(project, allowed_admin), allowed_admin))
        STAGE = 'private_disabled_deployment'
        environment = dict(os.environ); environment['PATH'] = str(tools) + ':' + environment.get('PATH', '/usr/bin:/bin')
        logged(['bash', 'scripts/test-synthetic-runtime-deployment.sh', revision, '--synthetic-precreated'], action / 'deploy.log', environment=environment)
        require(preserved(before, snapshot(project, allowed_admin), allowed_admin))
        STAGE = 'scheduler_configuration'
        config = fixture / 'config/operations.env'; data = checked_file(config)[0]
        settings = {'FCD_BACKUP_CALENDAR': '*-*-* 02:00:00 UTC', 'FCD_MAINTENANCE_CALENDAR': '*-*-* *:00/5:00 UTC', 'FCD_HEALTH_CALENDAR': '*-*-* *:*:00 UTC', 'FCD_MAINTENANCE_SLOT_SECONDS': '300', 'FCD_TIMER_TIMEOUT_SECONDS': '900', 'FCD_TIMER_MEMORY_MIB': '256', 'FCD_TIMER_TASKS_MAX': '128', 'FCD_TIMER_CPUS': '1', 'FCD_TIMER_ACCURACY_SECONDS': '1', 'FCD_TIMER_RANDOMIZED_DELAY_SECONDS': '0'}
        require(not any((key + '=').encode() in data for key in settings))
        prepared = action / 'operations-with-timers.env'; new_file(prepared, data + ''.join(key + '=' + value + '\n' for key, value in settings.items()).encode())
        os.replace(prepared, config)
        STAGE = 'scheduled_operations'
        for job in ['backup', 'backup', 'maintenance', 'health']:
            suffix = 'backup-replay' if job == 'backup' and (action / 'backup.log').exists() else job
            logged(['bash', 'scripts/run-operation.sh', job, revision, str(config)], action / (suffix + '.log'))
            require(preserved(before, snapshot(project, allowed_admin), allowed_admin))
        STAGE = 'timer_generation'
        logged(['bash', 'scripts/render-systemd-units.sh', revision, str(config), str(action / 'units')], action / 'timer-render.log')
        require(unit_admission(timer_rows()))
        STAGE = 'final_verification'
        logged(['bash', 'scripts/verify-runtime.sh', revision, str(config)], action / 'verify.log')
        require(preserved(before, snapshot(project, allowed_admin), allowed_admin))
        new_file(action / 'deployment-completed', b'completed\n')
        print('final_server_private_deployment_verified=true', flush=True)
        print('final_server_timers_rendered_not_installed=true', flush=True)
        print('final_server_preserved_inventory_verified=true', flush=True)
    finally:
        for fd in locks: os.close(fd)


if __name__ == '__main__':
    try: main()
    except Exception:
        print('final_server_refused_stage=' + STAGE, flush=True)
        raise SystemExit(1)
