"""Scoped root continuation of the preserved, partially installed timer generation."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

TARGET = '24e56679c9c29823b210ca6991608f83de556156'
OLD = 'b1e183df3e7c319483f863346925b38c4f149ba5'
ROOT = Path('/home/redwan/apps/fcd-support')
ACTION = Path('/home/redwan/fcd-support-p6-timer-upgrade-20261103')
PRIOR = Path('/home/redwan/fcd-support-p6-final-b1e183d')
FIXTURE = Path('/home/redwan/fcd-support-host-test-p6-b1e183d')
DESTINATION = Path('/etc/systemd/system')
OLD_HASHES = {
    'fcd-support-operation@.service': 'b1195ac904617028429044852dd395203d485806916937ff6bf8ce568d81ce8b',
    'fcd-support-backup.timer': 'e266a5376ec05d19ac3a4cd0b6d1e97998b3a47f81113e210b10ec2be1e7bd71',
    'fcd-support-maintenance.timer': '246c79998e48e758daf886fac147e9e3cc0a6ef4c476933a11d4a3507362fbc3',
    'fcd-support-health.timer': 'b9b6df5e00cf6e4c375702b27f14cbc6316f7fe5c5134fd90dfef4c1ccd1d14a',
}
NEW_HASHES = {
    'fcd-support-operation@.service': 'ffcd3f695df0073e8cb34012704787667088aabbbef005499dec4a668150ee37',
    'fcd-support-backup.timer': 'e266a5376ec05d19ac3a4cd0b6d1e97998b3a47f81113e210b10ec2be1e7bd71',
    'fcd-support-maintenance.timer': '246c79998e48e758daf886fac147e9e3cc0a6ef4c476933a11d4a3507362fbc3',
    'fcd-support-health.timer': 'b9b6df5e00cf6e4c375702b27f14cbc6316f7fe5c5134fd90dfef4c1ccd1d14a',
}
STAGE = 'root_admission'


def require(ok):
    if not ok:
        raise RuntimeError('timer_repair_refused')


def file_bytes(path, owner=None):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and stat.S_IMODE(before.st_mode) == 0o644 and 0 < before.st_size <= 16384
            and (owner is None or (before.st_uid, before.st_gid) == (owner, owner)))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno()); data = stream.read(16385); after = os.fstat(stream.fileno())
    identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid,
                              value.st_mode, value.st_size, value.st_mtime_ns, value.st_nlink)
    require(identity(before) == identity(opened) == identity(after)
            and len(data) == before.st_size and identity(path.lstat()) == identity(before))
    return data, identity(before)


def replace_generation(destination, contents, old_hashes, new_hashes):
    require(set(contents) == set(old_hashes) == set(new_hashes) == set(OLD_HASHES)
            and all(isinstance(data, bytes) and 0 < len(data) <= 16384
                    and hashlib.sha256(data).hexdigest() == new_hashes[name]
                    for name, data in contents.items()))
    old = {name: file_bytes(destination / name) for name in OLD_HASHES}
    require(all(hashlib.sha256(data).hexdigest() == old_hashes[name] for name, (data, _) in old.items()))
    before = destination.lstat()
    require(stat.S_ISDIR(before.st_mode) and destination.resolve(strict=True) == destination)
    directory = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(directory)
        require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino))
        for name, data in contents.items():
            if data == old[name][0]:
                continue
            temporary = '.' + name + '.fcd-task16-20261103.next'
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory)
            owned = os.fstat(fd)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    os.fchmod(stream.fileno(), 0o644); stream.write(data); stream.flush(); os.fsync(stream.fileno())
                require(file_bytes(destination / name) == old[name])
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                try:
                    current = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    current = None
                if current is not None and stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                    os.unlink(temporary, dir_fd=directory); os.fsync(directory)
    finally:
        os.close(directory)


def marker(name, data, mode=0o600):
    fd = os.open(ACTION / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    owned = os.fstat(fd)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode); stream.write(data); stream.flush(); os.fsync(stream.fileno())
        directory = os.open(ACTION, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    except BaseException:
        # Never leave this attempt's success record after timer containment.
        # Start/old-generation markers and any foreign replacement stay intact.
        if name == 'timer-repair-completed.json':
            try: current = (ACTION / name).lstat()
            except FileNotFoundError: current = None
            if current is not None and stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                os.unlink(ACTION / name)
                directory = os.open(ACTION, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    try: os.fsync(directory)
                    except OSError: pass
                finally: os.close(directory)
        raise


def verify_scheduled_services(run, manager, no_pending):
    global STAGE
    for job in ['backup', 'maintenance', 'health']:
        service = 'fcd-support-operation@' + job + '.service'
        STAGE = 'real_service_' + job; print('timer_repair_stage=' + STAGE, flush=True)
        manager.RefUnit(service, timeout=10)
        try:
            previous = run(['systemctl', 'show', service, '-p', 'ExecMainStartTimestampMonotonic', '--value'])
            require(previous.isdigit())
            run(['systemctl', 'start', service], timeout=1200)
            require(run(['systemctl', 'show', service, '-p', 'Result', '--value']) == 'success'
                    and run(['systemctl', 'show', service, '-p', 'ExecMainCode', '--value']) == '1'
                    and run(['systemctl', 'show', service, '-p', 'ExecMainStatus', '--value']) == '0')
            started = run(['systemctl', 'show', service, '-p', 'ExecMainStartTimestampMonotonic', '--value'])
            require(started.isdigit() and int(started) > int(previous) and no_pending())
        finally:
            manager.UnrefUnit(service, timeout=10)


def enable_timers(run, complete):
    timers = ['fcd-support-' + job + '.timer' for job in ['backup', 'maintenance', 'health']]
    try:
        run(['systemctl', 'enable', *timers]); run(['systemctl', 'start', *timers])
        for timer in timers:
            require(run(['systemctl', 'is-enabled', timer]) == 'enabled'
                    and run(['systemctl', 'is-active', timer]) == 'active')
        complete()
    except BaseException:
        # Stop future activations, never stop a dispatched service or settle SQL.
        contained = True
        for operation in ['stop', 'disable']:
            try: run(['systemctl', operation, *timers])
            except Exception: contained = False
        for timer in timers:
            try:
                require(run(['systemctl', 'show', timer, '-p', 'ActiveState', '--value']) == 'inactive'
                        and run(['systemctl', 'show', timer, '-p', 'UnitFileState', '--value']) == 'disabled')
            except Exception: contained = False
        print('timer_repair_timer_containment=' + ('verified' if contained else 'unverified'), flush=True)
        raise


def main():
    import fcntl
    global STAGE
    require(len(sys.argv) == 1 and sys.platform.startswith('linux') and os.getuid() == 0 and os.getgid() == 0
            and sys.flags.isolated == 1
            and re.fullmatch('[a-f0-9]{40}', TARGET) is not None)
    os.environ.clear(); os.environ.update({'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LC_ALL': 'C'})
    import dbus
    os.umask(0o077)
    library = ROOT / 'docs/operations/actions/2026-11-03-install-timers.py'
    library_bytes = library.read_bytes()
    require(hashlib.sha256(library_bytes).hexdigest() == 'f20831c688d22db8b7c08556334e2e67e0a4ec32c63214d9a94c0b7ca3967d94')
    lib = {'__name__': 'reviewed_timer_install_library', '__file__': str(library)}
    exec(compile(library_bytes, str(library), 'exec'), lib)
    lib['root_destination'](DESTINATION)
    for path in [ACTION, PRIOR, FIXTURE / 'state']:
        lib['private_directory'](path)
    read = lib['protected_read']; run = lib['run']
    require(not os.path.lexists(ACTION / 'timer-repair-started')
            and not os.path.lexists(ACTION / 'timer-repair-completed.json'))
    require(run(['git', 'rev-parse', 'HEAD'], operator=True) == TARGET
            and run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], operator=True) == '')
    completed = json.loads(read(ACTION / 'upgrade-completed.json'))
    require(completed == {'revision': TARGET, 'units': NEW_HASHES})
    contents = lib['read_generation'](ACTION / 'units', NEW_HASHES)
    prior_marker = PRIOR / 'timer-install-started'
    info = prior_marker.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, 0, 0o600)
            and prior_marker.read_bytes() == (OLD + '\n').encode()
            and not os.path.lexists(PRIOR / 'timer-install-completed.json'))
    jobs = ['backup', 'maintenance', 'health']
    services = ['fcd-support-operation@' + job + '.service' for job in jobs]
    timers = ['fcd-support-' + job + '.timer' for job in jobs]

    def old_admission():
        for name, digest in OLD_HASHES.items():
            require(hashlib.sha256(file_bytes(DESTINATION / name, owner=0)[0]).hexdigest() == digest)
        for service, timer in zip(services, timers):
            require(not os.path.lexists(DESTINATION / service))
            for unit, fragment in [(service, 'fcd-support-operation@.service'), (timer, timer)]:
                require(run(['systemctl', 'show', unit, '-p', 'FragmentPath', '--value']) == str(DESTINATION / fragment)
                        and run(['systemctl', 'show', unit, '-p', 'DropInPaths', '--value']) == '')
            require(run(['systemctl', 'show', service, '-p', 'ActiveState', '--value']) in ['inactive', 'failed']
                    and run(['systemctl', 'show', timer, '-p', 'ActiveState', '--value']) == 'inactive'
                    and run(['systemctl', 'show', timer, '-p', 'UnitFileState', '--value']) == 'disabled')

    old_admission()
    config_bytes = read(FIXTURE / 'config/operations.env')
    STAGE = 'operator_target_verification'; print('timer_repair_stage=' + STAGE, flush=True)
    run(['bash', 'scripts/verify-runtime.sh', TARGET, str(FIXTURE / 'config/operations.env')], timeout=1200, operator=True)
    STAGE = 'exclusive_exact_generation_replacement'; print('timer_repair_stage=' + STAGE, flush=True)
    read(FIXTURE / 'state/deployment.lock')
    lock = os.open(FIXTURE / 'state/deployment.lock', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        selection = dict(line.split('=', 1) for line in read(FIXTURE / 'state/deployment-state').decode().splitlines())
        require(selection['STATE_PHASE'] == 'ready' and selection['STATE_REVISION'] == TARGET
                and selection['STATE_PROJECT'] == FIXTURE.name and not os.path.lexists(FIXTURE / 'state/active-job'))
        require(read(FIXTURE / 'config/operations.env') == config_bytes
                and run(['git', 'rev-parse', 'HEAD'], operator=True) == TARGET
                and run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], operator=True) == '')
        old_admission()
        require(lib['read_generation'](ACTION / 'units', NEW_HASHES) == contents)
        for name in OLD_HASHES:
            require(contents[name] == read(PRIOR / 'units' / name).replace(OLD.encode(), TARGET.encode()))
        marker('timer-repair-started', (TARGET + '\n').encode())
        marker('timer-root-generation-before.json', json.dumps({name: file_bytes(DESTINATION / name, owner=0)[0].decode('utf-8') for name in OLD_HASHES}, sort_keys=True).encode())
        replace_generation(DESTINATION, contents, OLD_HASHES, NEW_HASHES)
        run(['systemd-analyze', 'verify', *[str(DESTINATION / name) for name in OLD_HASHES]])
        run(['systemctl', 'daemon-reload'])
        for name in services + timers:
            require(run(['systemctl', 'show', name, '-p', 'DropInPaths', '--value']) == '')
        for name in services:
            for key, value in {'User': '1000', 'Group': '1000', 'ProtectHome': 'read-only',
                               'ProtectSystem': 'strict', 'NoNewPrivileges': 'yes',
                               'MemoryMax': '268435456', 'TasksMax': '128',
                               'RestrictAddressFamilies': 'AF_UNIX'}.items():
                require(run(['systemctl', 'show', name, '-p', key, '--value']) == value)
    finally:
        os.close(lock)
    bus = dbus.SystemBus(private=True)
    try:
        manager = dbus.Interface(bus.get_object('org.freedesktop.systemd1', '/org/freedesktop/systemd1'),
                                 'org.freedesktop.systemd1.Manager')
        verify_scheduled_services(run, manager, lambda: not os.path.lexists(FIXTURE / 'state/active-job')
                                  and not any((FIXTURE / 'state').glob('active-job-*.next')))
    finally:
        bus.close()
    require(read(FIXTURE / 'config/operations.env') == config_bytes)
    STAGE = 'enable_only_three_timers'; print('timer_repair_stage=' + STAGE, flush=True)
    enable_timers(run, lambda: marker('timer-repair-completed.json', json.dumps({'revision': TARGET, 'units': NEW_HASHES,
            'servicesPassed': jobs, 'timersEnabled': jobs}, sort_keys=True).encode(), mode=0o644))
    print('task16_exact_timer_generation_repaired=true', flush=True)
    print('task16_real_scheduled_services_passed=true', flush=True)
    print('task16_three_timers_enabled_active=true', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('timer_repair_refused_stage=' + STAGE, flush=True)
        raise SystemExit(1)
