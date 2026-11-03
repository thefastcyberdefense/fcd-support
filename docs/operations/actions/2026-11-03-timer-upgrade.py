"""One-use managed upgrade of the existing private synthetic test project."""
import hashlib
import copy
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

OLD = 'b1e183df3e7c319483f863346925b38c4f149ba5'
TARGET = '24e56679c9c29823b210ca6991608f83de556156'
ROOT = Path('/home/redwan/apps/fcd-support')
PROJECT = 'fcd-support-host-test-p6-b1e183d'
FIXTURE = Path('/home/redwan') / PROJECT
PRIOR = Path('/home/redwan/fcd-support-p6-final-b1e183d')
ACTION = Path('/home/redwan/fcd-support-p6-timer-upgrade-20261103')
DESTINATION = Path('/etc/systemd/system')
OLD_UNITS = {
    'fcd-support-operation@.service': 'b1195ac904617028429044852dd395203d485806916937ff6bf8ce568d81ce8b',
    'fcd-support-backup.timer': 'e266a5376ec05d19ac3a4cd0b6d1e97998b3a47f81113e210b10ec2be1e7bd71',
    'fcd-support-maintenance.timer': '246c79998e48e758daf886fac147e9e3cc0a6ef4c476933a11d4a3507362fbc3',
    'fcd-support-health.timer': 'b9b6df5e00cf6e4c375702b27f14cbc6316f7fe5c5134fd90dfef4c1ccd1d14a',
}
STAGE = 'admission'
ENVIRONMENT = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/redwan', 'LC_ALL': 'C'}
# Actual pre-action observation, not a synthetic fixture or cause attribution.
WINDOW_START = '2026-11-03T03:47:20.000000000Z'
WINDOW_END = '2026-11-03T03:47:40.999999999Z'


def require(ok):
    if not ok:
        raise RuntimeError('timer_upgrade_refused')


def upgrade_configuration(data, project, old, target):
    require(isinstance(data, bytes) and 0 < len(data) <= 65536 and data.endswith(b'\n')
            and b'\x00' not in data and re.fullmatch('[a-f0-9]{40}', old) is not None
            and re.fullmatch('[a-f0-9]{40}', target) is not None and old != target)
    try:
        lines = data.decode('ascii').splitlines(keepends=True)
    except UnicodeError:
        raise RuntimeError('timer_upgrade_refused') from None
    expected = {'FCD_SUPPORT_REVISION': old, 'FCD_SUPPORT_IMAGE': project + '-application:' + old,
                'FCD_OPERATIONS_IMAGE': project + '-operations:' + old,
                'FCD_POSTGRES_IMAGE': project + '-postgres:' + old}
    require(all(sum(line.startswith(key + '=') for line in lines) == 1 for key in expected))
    require(all(key + '=' + value + '\n' in lines for key, value in expected.items()))
    return ''.join(line if line.split('=', 1)[0] not in expected
                   else line.replace(old, target) for line in lines).encode('ascii')


def qualify_observed_window(before, after, admin, equivalent, start=WINDOW_START, end=WINDOW_END):
    if equivalent(before, after, admin):
        return []
    first, second = copy.deepcopy(before), copy.deepcopy(after)
    a = {row['id']: row for row in first['actors']}; b = {row['id']: row for row in second['actors']}
    require(len(a) == len(first['actors']) and len(b) == len(second['actors']) and set(a) == set(b))
    changed = sorted(ident for ident in a if ident != admin and a[ident] != b[ident])
    require(len(changed) == 5)
    require(sorted(a[ident]['state'] for ident in changed) == ['exited', 'running', 'running', 'running', 'running'])
    require(sorted(a[ident]['health'] for ident in changed) == ['healthy', 'healthy', 'none', 'none', 'none'])
    deltas = []
    for ident in changed:
        old, current = a[ident], b[ident]
        require(old['state'] == current['state'] and old['health'] == current['health']
                and type(old['restarts']) is int and type(current['restarts']) is int
                and old['restarts'] >= 0 and current['restarts'] >= 0)
        deltas.append(current['restarts'] - old['restarts'])
        definition = old['static']
        require(not definition.get('synthetic') and not (definition.get('owner') or '').startswith('fcd-support')
                and not definition['name'].lstrip('/').startswith('fcd-support'))
        fields = {key for key in definition.keys() | current['static'].keys() if definition.get(key) != current['static'].get(key)}
        require('started' in fields and fields <= {'started', 'networks'}
                and start <= current['static']['started'] <= end)
        for actor in [old, current]:
            actor.pop('restarts'); actor['static'].pop('started')
            for endpoint in actor['static']['networks'].values():
                endpoint.pop('EndpointID', None); endpoint.pop('MacAddress', None)
    require(sorted(deltas) == [-1, 0, 0, 0, 0])
    for snapshot in [first, second]:
        for network in snapshot['networks']:
            for ident in changed:
                member = network['members'].get(ident)
                if member is not None:
                    member.pop('EndpointID', None); member.pop('MacAddress', None)
    require(equivalent(first, second, admin))
    return changed


def run(args, timeout=30):
    result = subprocess.run(args, cwd=ROOT, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=timeout,
                            env=ENVIRONMENT)
    require(result.returncode == 0 and len(result.stdout) <= 4194304 and len(result.stderr) <= 4194304)
    return result.stdout.strip()


def installed_generation():
    for name, digest in OLD_UNITS.items():
        path = DESTINATION / name
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, 0, 0o644)
                and hashlib.sha256(path.read_bytes()).hexdigest() == digest)
    for job in ['backup', 'maintenance', 'health']:
        service = 'fcd-support-operation@' + job + '.service'
        timer = 'fcd-support-' + job + '.timer'
        for unit, fragment in [(service, 'fcd-support-operation@.service'), (timer, timer)]:
            require(run(['systemctl', 'show', unit, '-p', 'FragmentPath', '--value']) == str(DESTINATION / fragment))
            require(run(['systemctl', 'show', unit, '-p', 'DropInPaths', '--value']) == '')
        require(run(['systemctl', 'show', service, '-p', 'ActiveState', '--value']) in ['inactive', 'failed'])
        require(run(['systemctl', 'show', timer, '-p', 'ActiveState', '--value']) == 'inactive')
        require(run(['systemctl', 'show', timer, '-p', 'UnitFileState', '--value']) == 'disabled')
    marker = (PRIOR / 'timer-install-started').lstat()
    require(stat.S_ISREG(marker.st_mode) and marker.st_nlink == 1
            and (marker.st_uid, marker.st_gid, stat.S_IMODE(marker.st_mode)) == (0, 0, 0o600)
            and not os.path.lexists(PRIOR / 'timer-install-completed.json'))


def preserved_inputs():
    result = {}
    for root in [FIXTURE / 'config', FIXTURE / 'secrets']:
        for path in sorted(root.rglob('*')):
            if path == FIXTURE / 'config/operations.env':
                continue
            info = path.lstat()
            require(not stat.S_ISLNK(info.st_mode))
            result[str(path)] = [info.st_dev, info.st_ino, info.st_uid, info.st_gid,
                                 info.st_mode, info.st_size, info.st_mtime_ns]
    path = PRIOR / 'synthetic-admin-proof-credentials.json'
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o600))
    result[str(path)] = [info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns]
    return result


def main():
    import fcntl
    global STAGE
    require(len(sys.argv) == 2 and sys.argv[1] in ['--inspect', '--upgrade']
            and re.fullmatch('[a-f0-9]{40}', TARGET) is not None
            and os.getuid() == 1000 and os.getgid() == 1000)
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'))
    # Imported immutable preservation helpers also spawn children. Give them
    # the same environment used by admission; no inherited Git/Docker/Bash hooks.
    os.environ.clear(); os.environ.update(ENVIRONMENT)
    require(run(['docker', 'context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}', run(['docker', 'context', 'show'])]) == 'unix:///var/run/docker.sock')
    # b1e183d predates publication of this immutable library. Provision its
    # exact reviewed bytes separately; never change the old source to import it.
    library = Path('/home/redwan/fcd-support-p6-timer-preservation-20261103.py')
    info = library.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o400))
    library_bytes = library.read_bytes()
    require(hashlib.sha256(library_bytes).hexdigest() == '5d8434c1b9ae5406b84a6b1bf463b2991851c4334a2598b2584014138f30f6f5')
    lib = {'__name__': 'reviewed_server_preservation_library', '__file__': str(library)}
    exec(compile(library_bytes, str(library), 'exec'), lib)
    def logged(args, path, timeout=2400):
        lib['logged'](args, path, timeout=timeout, environment=ENVIRONMENT)
    read = lib['checked_file']; private = lib['private_directory']; new = lib['new_file']
    require(run(['git', 'rev-parse', 'HEAD']) == OLD and run(['git', 'status', '--porcelain=v1', '--untracked-files=all']) == '')
    require(not os.path.lexists(ACTION))
    installed_generation(); private(PRIOR); private(FIXTURE / 'state')
    require(read(PRIOR / 'deployment-completed')[0] == b'completed\n')
    config = FIXTURE / 'config/operations.env'
    original = read(config)[0]; prepared = upgrade_configuration(original, PROJECT, OLD, TARGET)
    selection = dict(line.split('=', 1) for line in read(FIXTURE / 'state/deployment-state')[0].decode().splitlines())
    require(selection['STATE_PHASE'] == 'ready' and selection['STATE_REVISION'] == OLD
            and selection['STATE_PROJECT'] == PROJECT and not os.path.lexists(FIXTURE / 'state/active-job'))
    anchor = json.loads(read(Path('/home/redwan/fcd-support-p6-action-67a4a4b/second-boot-recovery/current-baseline.json'))[0])['admin']['id']
    baseline_bytes, baseline_fingerprint = read(PRIOR / 'baseline.json', 4194304)
    baseline = json.loads(baseline_bytes)
    before = lib['snapshot'](PROJECT, anchor)
    qualified = qualify_observed_window(baseline, before, anchor, lib['preserved'])
    lib['assert_preserved'](before, lib['snapshot'](PROJECT, anchor), anchor)
    inputs = preserved_inputs()
    locks = []
    try:
        for state in sorted(Path('/home/redwan').glob('fcd-support-host-test-p6-*/state')):
            if state.parent.name == PROJECT:
                continue
            read(state / 'deployment.lock')
            fd = os.open(state / 'deployment.lock', os.O_RDONLY | os.O_NOFOLLOW)
            locks.append(fd); fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        require(os.statvfs('/var/lib/docker').f_bavail * os.statvfs('/var/lib/docker').f_frsize >= 12 * 1024**3)
        for role in ['application', 'operations', 'postgres']:
            require(not run(['docker', 'image', 'ls', '--quiet', PROJECT + '-' + role + ':' + TARGET]))
        lib['assert_preserved'](before, lib['snapshot'](PROJECT, anchor), anchor)
        require(read(PRIOR / 'baseline.json', 4194304)[1] == baseline_fingerprint)
        print('timer_upgrade_read_only_admission=true', flush=True)
        if sys.argv[1] == '--inspect':
            return
        os.umask(0o077); ACTION.mkdir(mode=0o700)
        new(ACTION / 'baseline.json', json.dumps(before, sort_keys=True).encode())
        new(ACTION / 'pre-admission-qualification.json', json.dumps({'originalBaseline': baseline_fingerprint,
            'observedLifecycleActors': qualified, 'windowStart': WINDOW_START, 'windowEnd': WINDOW_END}, sort_keys=True).encode())
        new(ACTION / 'inputs.json', json.dumps(inputs, sort_keys=True).encode())
        new(ACTION / 'operations-before.env', original)
        new(ACTION / 'upgrade-started', (TARGET + '\n').encode())
        STAGE = 'old_public_verification'
        logged(['bash', 'scripts/verify-runtime.sh', OLD, str(config)], ACTION / 'verify-before.log')
        own_lock = os.open(FIXTURE / 'state/deployment.lock', os.O_RDONLY | os.O_NOFOLLOW)
        locks.append(own_lock); fcntl.flock(own_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(read(config)[0] == original and preserved_inputs() == inputs
                and not os.path.lexists(FIXTURE / 'state/active-job'))
        require(dict(line.split('=', 1) for line in read(FIXTURE / 'state/deployment-state')[0].decode().splitlines()) == selection)
        installed_generation()
        STAGE = 'reviewed_source_checkout'
        logged(['git', 'fetch', 'origin', TARGET], ACTION / 'fetch.log', 90)
        logged(['git', 'checkout', '--detach', TARGET], ACTION / 'checkout.log', 30)
        require(run(['git', 'rev-parse', 'HEAD']) == TARGET and run(['git', 'status', '--porcelain=v1', '--untracked-files=all']) == '')
        STAGE = 'three_revision_pinned_images'
        for role in ['application', 'operations', 'postgres']:
            file = 'Dockerfile' if role == 'application' else 'infra/Dockerfile.' + role
            logged(['docker', 'build', '--platform', 'linux/amd64', '--build-arg', 'VCS_REF=' + TARGET,
                           '--label', 'fcd-support.synthetic-host-test=' + PROJECT, '--file', file,
                           '--tag', PROJECT + '-' + role + ':' + TARGET, str(ROOT)], ACTION / ('build-' + role + '.log'), 2400)
        STAGE = 'exact_configuration_transition'
        lock = own_lock
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(read(config)[0] == original and preserved_inputs() == inputs
                    and not os.path.lexists(FIXTURE / 'state/active-job'))
            require(dict(line.split('=', 1) for line in read(FIXTURE / 'state/deployment-state')[0].decode().splitlines()) == selection)
            installed_generation()
            next_config = config.with_name('operations-timer-upgrade.next')
            new(next_config, prepared); os.replace(next_config, config)
            directory = os.open(config.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
        STAGE = 'public_managed_upgrade'
        logged(['bash', 'scripts/deploy-runtime.sh', TARGET, '--mode', 'private-disabled', str(config)], ACTION / 'deploy.log')
        STAGE = 'target_verification'
        logged(['bash', 'scripts/verify-runtime.sh', TARGET, str(config)], ACTION / 'verify-after.log')
        after = dict(line.split('=', 1) for line in read(FIXTURE / 'state/deployment-state')[0].decode().splitlines())
        require(after['STATE_PHASE'] == 'ready' and after['STATE_REVISION'] == TARGET)
        for field in ['STATE_PROJECT', 'STATE_VOLUME', 'STATE_VOLUME_ORIGIN', 'STATE_VOLUME_LOGICAL',
                      'STATE_VOLUME_CREATED_AT', 'STATE_SYSTEM_IDENTIFIER', 'STATE_DATABASE_NAME',
                      'STATE_SCHEMA_NAME', 'STATE_SCHEMA_REVISION']:
            require(after[field] == selection[field])
        require(preserved_inputs() == inputs and read(config)[0] == prepared)
        for job in ['backup', 'maintenance', 'health']:
            STAGE = 'target_scheduled_' + job
            logged(['bash', 'scripts/run-operation.sh', job, TARGET, str(config)], ACTION / (job + '.log'))
        STAGE = 'target_timer_generation'
        logged(['bash', 'scripts/render-systemd-units.sh', TARGET, str(config), str(ACTION / 'units')], ACTION / 'render.log')
        unit_hashes = {}
        for name in OLD_UNITS:
            data = read(ACTION / 'units' / name)[0]
            expected = read(PRIOR / 'units' / name)[0].replace(OLD.encode(), TARGET.encode())
            require(data == expected)
            unit_hashes[name] = hashlib.sha256(data).hexdigest()
        fcntl.flock(own_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        installed_generation()
        lib['assert_preserved'](before, lib['snapshot'](PROJECT, anchor), anchor)
        require(preserved_inputs() == inputs and read(config)[0] == prepared)
        require(read(PRIOR / 'baseline.json', 4194304)[1] == baseline_fingerprint)
        require(dict(line.split('=', 1) for line in read(FIXTURE / 'state/deployment-state')[0].decode().splitlines()) == after)
        require(all(not os.path.lexists(FIXTURE / 'state' / name)
                    for name in ['active-job', 'active-job.next', 'deployment-state.next']))
        require(not any((FIXTURE / 'state').glob('active-job-*.next')))
        require(run(['git', 'rev-parse', 'HEAD']) == TARGET and run(['git', 'status', '--porcelain=v1', '--untracked-files=all']) == '')
        new(ACTION / 'upgrade-completed.json', json.dumps({'revision': TARGET, 'units': unit_hashes}, sort_keys=True).encode())
        print('timer_upgrade_existing_database_identity_verified=true', flush=True)
        print('timer_upgrade_three_scheduled_jobs_and_generation_passed=true', flush=True)
        print('timer_upgrade_other_scopes_preserved=true', flush=True)
    finally:
        for fd in locks:
            os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('timer_upgrade_refused_stage=' + STAGE, flush=True)
        raise SystemExit(1)
