"""Scoped root installation of the exact reviewed fresh test timer generation."""

from pathlib import Path
import os
import hashlib
import json
import re
import stat
import subprocess
import sys

UNIT_HASHES = {
    'fcd-support-operation@.service': 'b1195ac904617028429044852dd395203d485806916937ff6bf8ce568d81ce8b',
    'fcd-support-backup.timer': 'e266a5376ec05d19ac3a4cd0b6d1e97998b3a47f81113e210b10ec2be1e7bd71',
    'fcd-support-maintenance.timer': '246c79998e48e758daf886fac147e9e3cc0a6ef4c476933a11d4a3507362fbc3',
    'fcd-support-health.timer': 'b9b6df5e00cf6e4c375702b27f14cbc6316f7fe5c5134fd90dfef4c1ccd1d14a',
}
REVISION = 'b1e183df3e7c319483f863346925b38c4f149ba5'
ROOT = Path('/home/redwan/apps/fcd-support')
ACTION = Path('/home/redwan/fcd-support-p6-final-b1e183d')
FIXTURE = Path('/home/redwan/fcd-support-host-test-p6-b1e183d')
DESTINATION = Path('/etc/systemd/system')
JOBS = ['backup', 'maintenance', 'health']
TIMERS = ['fcd-support-' + job + '.timer' for job in JOBS]
SERVICES = ['fcd-support-operation@' + job + '.service' for job in JOBS]
STAGE = 'root_admission'


def require(value):
    if not value: raise RuntimeError('timer_install_refused')


def root_destination(path):
    require(path.is_absolute() and path.resolve(strict=True) == path)
    for current in [path, *path.parents]:
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                and stat.S_IMODE(info.st_mode) & 0o022 == 0)


def validate_generation(contents, expected=UNIT_HASHES):
    return (isinstance(contents, dict) and isinstance(expected, dict)
            and set(contents) == set(expected) == set(UNIT_HASHES)
            and all(isinstance(data, bytes) and 0 < len(data) <= 16384
                    and isinstance(expected[name], str)
                    and re.fullmatch('[a-f0-9]{64}', expected[name]) is not None
                    and hashlib.sha256(data).hexdigest() == expected[name]
                    for name, data in contents.items()))


def private_directory(path):
    info = path.lstat()
    require(path.is_absolute() and path.resolve(strict=True) == path and stat.S_ISDIR(info.st_mode)
            and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o700))


def protected_read(path, limit=16384):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) == (1000, 1000, 0o600)
            and before.st_size <= limit)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno()); data = stream.read(limit + 1); after = os.fstat(stream.fileno())
    require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino)
            and (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
            and len(data) == before.st_size)
    return data


def read_generation(source, expected=UNIT_HASHES):
    private_directory(source)
    require(set(path.name for path in source.iterdir()) == set(UNIT_HASHES))
    contents = {name: protected_read(source / name) for name in UNIT_HASHES}
    require(validate_generation(contents, expected))
    return contents


def install_generation(destination, contents, expected=UNIT_HASHES):
    require(validate_generation(contents, expected))
    info = destination.lstat()
    require(destination.is_absolute() and destination.resolve(strict=True) == destination and stat.S_ISDIR(info.st_mode))
    require(not any(os.path.lexists(destination / name) for name in UNIT_HASHES))
    directory = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    created = []
    try:
        opened = os.fstat(directory)
        require((info.st_dev, info.st_ino) == (opened.st_dev, opened.st_ino))
        for name, data in contents.items():
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory)
            owned = os.fstat(fd); created.append((name, owned.st_dev, owned.st_ino))
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o644)
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.fsync(directory)
    except BaseException:
        # Never remove a pre-existing or subsequently replaced file.
        for name, device, inode in reversed(created):
            try: current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError: continue
            if stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == (device, inode):
                os.unlink(name, dir_fd=directory)
        os.fsync(directory)
        raise
    finally:
        os.close(directory)


def run(args, timeout=30, operator=False):
    if operator:
        args = ['/usr/bin/setpriv', '--reuid=1000', '--regid=1000', '--init-groups', '--no-new-privs', '--'] + args
    result = subprocess.run(args, cwd=ROOT, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=timeout,
                            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/redwan', 'LC_ALL': 'C'})
    require(result.returncode == 0 and len(result.stdout) <= 1048576 and len(result.stderr) <= 1048576)
    return result.stdout.strip()


def absent_units():
    for name in list(UNIT_HASHES) + SERVICES:
        for parent in ['/etc/systemd/system', '/run/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system']:
            require(not os.path.lexists(Path(parent) / name))
            require(not os.path.lexists(Path(parent) / (name + '.d')))
    for timer in TIMERS:
        require(not os.path.lexists(DESTINATION / 'timers.target.wants' / timer))
    for name in SERVICES + TIMERS:
        require(run(['/usr/bin/systemctl', 'show', name, '-p', 'LoadState', '--value']) == 'not-found')
        require(run(['/usr/bin/systemctl', 'show', name, '-p', 'FragmentPath', '--value']) == '')


def marker(name, data, mode):
    fd = os.open(ACTION / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), mode); stream.write(data); stream.flush(); os.fsync(stream.fileno())
    directory = os.open(ACTION, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(directory)
    finally: os.close(directory)


def main():
    import fcntl
    global STAGE
    require(len(sys.argv) == 1 and sys.platform.startswith('linux') and os.getuid() == 0 and os.getgid() == 0)
    os.umask(0o077)
    root_destination(DESTINATION)
    private_directory(ACTION); private_directory(FIXTURE / 'state')
    require(ROOT.resolve(strict=True) == ROOT)
    require(protected_read(ACTION / 'deployment-completed') == b'completed\n')
    require(not os.path.lexists(ACTION / 'timer-install-started') and not os.path.lexists(ACTION / 'timer-install-completed.json'))
    require(run(['/usr/bin/git', 'rev-parse', 'HEAD'], operator=True) == REVISION)
    require(run(['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all'], operator=True) == '')
    contents = read_generation(ACTION / 'units')
    absent_units()
    STAGE = 'operator_public_verification'; print('timer_install_stage=' + STAGE, flush=True)
    run(['/usr/bin/bash', 'scripts/verify-runtime.sh', REVISION, str(FIXTURE / 'config/operations.env')], timeout=1200, operator=True)
    STAGE = 'exclusive_installation'; print('timer_install_stage=' + STAGE, flush=True)
    protected_read(FIXTURE / 'state/deployment.lock')
    lock = os.open(FIXTURE / 'state/deployment.lock', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not os.path.lexists(FIXTURE / 'state/active-job'))
        selection = dict(line.split('=', 1) for line in protected_read(FIXTURE / 'state/deployment-state').decode().splitlines())
        require(selection['STATE_PHASE'] == 'ready' and selection['STATE_REVISION'] == REVISION
                and selection['STATE_PROJECT'] == 'fcd-support-host-test-p6-b1e183d')
        require(read_generation(ACTION / 'units') == contents)
        absent_units()
        marker('timer-install-started', (REVISION + '\n').encode(), 0o600)
        install_generation(DESTINATION, contents)
        run(['/usr/bin/systemd-analyze', 'verify', *[str(DESTINATION / name) for name in UNIT_HASHES]])
        run(['/usr/bin/systemctl', 'daemon-reload'])
        for name in SERVICES + TIMERS:
            # Refuse inherited/global drop-ins before executing a new unit.
            require(run(['/usr/bin/systemctl', 'show', name, '-p', 'DropInPaths', '--value']) == '')
        for name in SERVICES:
            require(run(['/usr/bin/systemctl', 'show', name, '-p', 'User', '--value']) == '1000')
            require(run(['/usr/bin/systemctl', 'show', name, '-p', 'Group', '--value']) == '1000')
    finally:
        os.close(lock)
    for job, service in zip(JOBS, SERVICES):
        STAGE = 'real_service_' + job; print('timer_install_stage=' + STAGE, flush=True)
        run(['/usr/bin/systemctl', 'start', service], timeout=1200)
        require(run(['/usr/bin/systemctl', 'show', service, '-p', 'Result', '--value']) == 'success')
        require(run(['/usr/bin/systemctl', 'show', service, '-p', 'ExecMainStatus', '--value']) == '0')
    STAGE = 'enable_only_three_timers'; print('timer_install_stage=' + STAGE, flush=True)
    run(['/usr/bin/systemctl', 'enable', *TIMERS])
    run(['/usr/bin/systemctl', 'start', *TIMERS])
    for timer in TIMERS:
        require(run(['/usr/bin/systemctl', 'is-enabled', timer]) == 'enabled')
        require(run(['/usr/bin/systemctl', 'is-active', timer]) == 'active')
    marker('timer-install-completed.json', json.dumps({'revision': REVISION, 'unitHashes': UNIT_HASHES,
           'manualServices': 'passed', 'timers': 'enabled_active'}, sort_keys=True).encode() + b'\n', 0o644)
    print('task16_exact_timer_units_installed=true', flush=True)
    print('task16_real_scheduled_services_passed=true', flush=True)
    print('task16_three_timers_enabled_active=true', flush=True)


if __name__ == '__main__':
    try: main()
    except Exception:
        print('timer_install_refused_stage=' + STAGE, flush=True)
        raise SystemExit(1)
