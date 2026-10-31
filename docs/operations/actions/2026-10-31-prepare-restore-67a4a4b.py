# Single-use synthetic configuration preparation; never starts a SQL job.
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys

ROOT = Path('/home/redwan/apps/fcd-support')
FIXTURE = Path('/home/redwan/fcd-support-host-test-p6-67a4a4b')
ACTION = Path('/home/redwan/fcd-support-p6-action-67a4a4b/restore-drill')
REVISION = '67a4a4bede6d3252dc936a6e410f4b90c1359ac3'
TARGET = 'fcd-support-restore-host-test-p6-67a4a4b'
STAGE = 'preflight'

def require(value):
    if not value: raise RuntimeError('refused')

def run(args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
    require(result.returncode == 0 and len(result.stdout) <= 2097152)
    return result.stdout.strip()

def read(path):
    require(path.resolve(strict=True) == path)
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink) == (1000, 1000, 0o600, 1) and before.st_size <= 65536)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        opened = os.fstat(source.fileno())
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
        data = source.read(65537)
    after = path.lstat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) and len(data) == before.st_size)
    return data

def fields(data):
    result = {}
    for line in data.decode('ascii').splitlines():
        if not line or line.startswith('#'): continue
        key, value = line.split('=', 1)
        require(key not in result)
        result[key] = value
    return result

def write_new(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(data); output.flush(); os.fsync(output.fileno())

def sync(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)

def validate():
    require(os.getuid() == 1000 and os.getgid() == 1000 and not os.path.lexists(ACTION))
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'))
    context = run(['docker', 'context', 'show'])
    require(run(['docker', 'context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}', context]) == 'unix:///var/run/docker.sock')
    require(run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']) == REVISION and not run(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '--untracked-files=all']))
    require(fields(read(FIXTURE / 'state/deployment-state'))['STATE_PHASE'] == 'ready' and not os.path.lexists(FIXTURE / 'state/active-job'))
    require(not list((FIXTURE / 'state').glob('active-job-*.next')) and not os.path.lexists(FIXTURE / 'state/deployment-state.next'))
    require(not run(['docker', 'ps', '--all', '--quiet', '--filter', 'label=com.docker.compose.project=' + TARGET]))
    for kind in ['network', 'volume']:
        require(not run(['docker', kind, 'ls', '--quiet', '--filter', 'name=^' + TARGET + '-data$']))
    require(run(['node', str(ROOT / 'scripts/operations-restore-subnet.ts'), '198.19.8.0/24']) == 'restore_subnet_safe')
    paths = [FIXTURE / 'config/operations.env', FIXTURE / 'config/restore.env']
    originals = [read(path) for path in paths]
    host, restore = [fields(data) for data in originals]
    require(host['FCD_RUNTIME_PROJECT'] == FIXTURE.name and host['FCD_RESTORE_PROJECT'] == TARGET and host['FCD_RESTORE_VOLUME'] == TARGET + '-data' and host['FCD_SUPPORT_REVISION'] == REVISION)
    require('FCD_RESTORE_SUBNET' not in host and originals[0].endswith(b'\n'))
    require(restore['CHECKPOINT_MAX_AGE_MS'] == '60000' and originals[1].splitlines().count(b'CHECKPOINT_MAX_AGE_MS=60000') == 1)
    modified = [originals[0] + b'FCD_RESTORE_SUBNET=198.19.8.0/24\n', b'\n'.join(b'CHECKPOINT_MAX_AGE_MS=600000' if line == b'CHECKPOINT_MAX_AGE_MS=60000' else line for line in originals[1].split(b'\n'))]
    expected_host = dict(host, FCD_RESTORE_SUBNET='198.19.8.0/24')
    expected_restore = dict(restore, CHECKPOINT_MAX_AGE_MS='600000')
    require(fields(modified[0]) == expected_host and fields(modified[1]) == expected_restore)
    ids = run(['docker', 'ps', '--all', '--quiet', '--no-trunc']).splitlines()
    require(ids and len(ids) <= 1000)
    sources = run(['docker', 'inspect', '--format', '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}', *ids]).splitlines()
    for source in sources:
        if source:
            require(all(os.path.commonpath([str(path), source]) not in [str(path), source] for path in paths))
    return paths, originals, modified

try:
    require(len(sys.argv) == 2 and sys.argv[1] in ['--inspect', '--apply'])
    paths, originals, modified = validate()
    print('synthetic_restore_config_preflight=true', flush=True)
    if sys.argv[1] == '--apply':
        STAGE = 'lock'
        lock = FIXTURE / 'state/deployment.lock'; read(lock)
        descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(validate() == (paths, originals, modified))
            parent = ACTION.parent
            require(parent.resolve(strict=True) == parent and (parent.stat().st_uid, parent.stat().st_gid, stat.S_IMODE(parent.stat().st_mode)) == (1000, 1000, 0o700))
            os.umask(0o077); ACTION.mkdir(mode=0o700)
            STAGE = 'simulation'
            for path, original, candidate in zip(paths, originals, modified):
                write_new(ACTION / (path.name + '.original'), original)
                simulation = ACTION / (path.name + '.simulation')
                write_new(simulation, candidate)
                require(read(simulation) == candidate)
            run(['bash', '-c', 'source "$1/scripts/operations-common.sh"; operations_load_config "$2"', 'config-check', str(ROOT), str(ACTION / 'operations.env.simulation')])
            sync(ACTION)
            STAGE = 'replace'
            for path, original, candidate in zip(paths, originals, modified):
                require(read(path) == original)
                pending = path.with_name(path.name + '.restore-drill.next')
                write_new(pending, candidate)
                require(read(path) == original)
                os.replace(pending, path)
                sync(path.parent)
                require(read(path) == candidate)
            run(['bash', '-c', 'source "$1/scripts/operations-common.sh"; operations_load_config "$2"', 'config-check', str(ROOT), str(paths[0])])
            require(fields(read(FIXTURE / 'state/deployment-state'))['STATE_PHASE'] == 'ready' and not os.path.lexists(FIXTURE / 'state/active-job'))
            print('synthetic_restore_config_prepared=true', flush=True)
        finally: os.close(descriptor)
except Exception:
    print('synthetic_restore_config_refused_stage=' + STAGE, flush=True)
    raise SystemExit(1)
