"""Read-only admission for a fresh private test scope. No deployment mode."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys

APPROVED_SOURCE = '5ede82cbabe046e9d1f00ef14727901f2555ae0d'
HOME_ROOT = Path('/home/redwan')
OLD_ROOT = HOME_ROOT / 'apps/fcd-support'
HELD_PROJECT = 'fcd-support-host-test-p6-b1e183d'
HELD_ROOT = HOME_ROOT / HELD_PROJECT
ENDPOINT = 'unix:///var/run/docker.sock'
STAGES = {'arguments', 'native', 'source', 'journal', 'paths', 'containers',
          'networks', 'volumes', 'scheduler', 'resources', 'preservation', 'inspection'}
UNITS = ('fcd-support-operation@.service', 'fcd-support-backup.timer',
         'fcd-support-maintenance.timer', 'fcd-support-health.timer')


class Refusal(Exception):
    def __init__(self, stage):
        self.stage = stage if stage in STAGES else 'inspection'
        super().__init__('successor_preflight_refused')


def require(ok, stage):
    if not ok:
        raise Refusal(stage)


def inspect_arguments(args):
    require(args == ['--inspect', APPROVED_SOURCE], 'arguments')
    return APPROVED_SOURCE


def parse_held_job(raw, parent):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 4096 and b'\x00' not in raw
            and raw.endswith(b'\n'), 'journal')
    fields = {}
    for line in raw.decode('ascii').splitlines():
        key, separator, value = line.partition('=')
        require(separator and key not in fields and value, 'journal')
        fields[key] = value
    expected = {'JOB_VERSION', 'JOB_REF', 'JOB_PARENT', 'JOB_SERVICE', 'JOB_REVISION',
                'JOB_IMAGE', 'JOB_COMMAND_SHA256', 'JOB_CONTAINER', 'JOB_PHASE'}
    require(set(fields) == expected, 'journal')
    require(fields['JOB_VERSION'] == '1' and fields['JOB_PARENT'] == parent
            and fields['JOB_SERVICE'] == 'health' and fields['JOB_PHASE'] == 'uncertain', 'journal')
    for key, pattern in [('JOB_REF', r'operation_[a-f0-9]{32}'),
                         ('JOB_REVISION', r'[a-f0-9]{40}'),
                         ('JOB_IMAGE', r'sha256:[a-f0-9]{64}'),
                         ('JOB_COMMAND_SHA256', r'[a-f0-9]{64}'),
                         ('JOB_CONTAINER', r'[a-f0-9]{64}')]:
        require(re.fullmatch(pattern, fields[key]) is not None, 'journal')
    return fields


def require_disjoint(target, mount_roots):
    path = PurePosixPath(target)
    require(path.is_absolute() and str(path) == target and not target.startswith('//') and '..' not in path.parts, 'paths')
    for source in mount_roots:
        other = PurePosixPath(source)
        require(other.is_absolute() and str(other) == source and not source.startswith('//') and '..' not in other.parts, 'paths')
        require(path != other and path not in other.parents and other not in path.parents, 'paths')


def require_namespace_absent(project, containers, networks, volumes):
    require(re.fullmatch('[a-z0-9][a-z0-9_-]+', project) is not None, 'arguments')
    require(not any(row['project'] == project or row['name'].lstrip('/') == project
                    or row['name'].lstrip('/').startswith((project + '-', project + '_'))
                    for row in containers), 'containers')
    require(not any(project in row['name'] for row in networks), 'networks')
    require(not any(row['name'].startswith(project) for row in volumes), 'volumes')


def choose_block(existing, routes):
    try:
        present = [ipaddress.ip_network(value, strict=False) for value in existing + routes]
    except (TypeError, ValueError):
        raise Refusal('networks') from None
    present = [item for item in present if item.prefixlen != 0]
    for start in range(0, 256, 16):
        block = ipaddress.ip_network('198.19.' + str(start) + '.0/20')
        if not any(item.version == 4 and block.overlaps(item) for item in present):
            return str(block)
    raise Refusal('networks')


def require_preserved(before, after, volatile_admin):
    def canonical(rows):
        result = {}
        for row in rows:
            require(isinstance(row, dict) and isinstance(row.get('id'), str)
                    and row['id'] not in result, 'preservation')
            item = dict(row)
            if row['id'] == volatile_admin:
                for field in ('running', 'restarting', 'health'):
                    item.pop(field, None)
            result[row['id']] = item
        return result
    require(canonical(before) == canonical(after), 'preservation')


def require_scheduler_binding(command, source, revision, config, service='health'):
    expected = 'argv[]=/usr/bin/bash ' + source + '/scripts/run-operation.sh ' + service + ' ' + revision + ' ' + config
    require(re.search(re.escape(expected) + r'(?=\s*;|$)', command) is not None, 'scheduler')


class Reader:
    """Fixed read-only local tools, bounded output and no external credentials."""
    def run(self, argv, stage):
        require(isinstance(argv, list) and argv and all(isinstance(item, str) for item in argv), stage)
        if argv[0] == 'docker':
            require(argv[1:3] == ['--host', ENDPOINT], stage)
            tail = argv[3:]
            require(any(tuple(tail[:len(prefix)]) == prefix for prefix in
                        [('ps',), ('container', 'inspect'), ('network', 'ls'),
                         ('network', 'inspect'), ('volume', 'ls'), ('volume', 'inspect'), ('image', 'ls')]), stage)
        elif argv[0] == 'git':
            require(argv[:6] == ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', str(OLD_ROOT)]
                    and argv[6:] in (['rev-parse', 'HEAD'],
                                     ['status', '--porcelain=v1', '--untracked-files=all']), stage)
        elif argv[0] == 'systemctl':
            require(argv[1] == 'show', stage)
        else:
            require(argv[:4] == ['ip', '-j', 'route', 'show'] or
                    argv == ['df', '-Pk', '/var/lib/docker'], stage)
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=15,
                                  env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LC_ALL': 'C',
                                       'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0'})
        except (OSError, subprocess.SubprocessError):
            raise Refusal(stage) from None
        require(proc.returncode == 0 and len(proc.stdout) <= 4194304, stage)
        return proc.stdout.strip()

    def docker(self, *argv, stage='containers'):
        return self.run(['docker', '--host', ENDPOINT, *argv], stage)


def checked_file(path, uid, mode, maximum=4096):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and not path.is_symlink() and before.st_nlink == 1
            and before.st_uid == uid and before.st_gid == uid and stat.S_IMODE(before.st_mode) == mode
            and 0 < before.st_size <= maximum, 'journal' if mode == 0o600 else 'scheduler')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        require((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) ==
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns), 'preservation')
        raw = os.read(descriptor, maximum + 1)
    finally:
        os.close(descriptor)
    after = path.lstat()
    identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
                             item.st_uid, item.st_gid, item.st_mode, item.st_nlink)
    require(identity(before) == identity(after) and len(raw) == before.st_size, 'preservation')
    return raw, (identity(after), hashlib.sha256(raw).digest())


def container_snapshot(reader):
    ids = reader.docker('ps', '--all', '--quiet', '--no-trunc').splitlines()
    require(1 <= len(ids) <= 500 and all(re.fullmatch('[a-f0-9]{64}', item) for item in ids), 'containers')
    projection = ('{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},'
                  '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                  '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                  '"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},'
                  '"running":{{json .State.Running}},'
                  '"restarting":{{json .State.Restarting}},'
                  '"health":{{if (index .State "Health")}}{{json (index .State "Health" "Status")}}{{else}}null{{end}}}')
    raw = reader.docker('container', 'inspect', '--format', projection, *ids)
    rows = [json.loads(line) for line in raw.splitlines()]
    require(len(rows) == len(ids) and {row.get('id') for row in rows} == set(ids), 'containers')
    return rows


def network_snapshot(reader):
    ids = reader.docker('network', 'ls', '--quiet', '--no-trunc', stage='networks').splitlines()
    require(0 < len(ids) <= 500 and len(set(ids)) == len(ids) and
            all(re.fullmatch('[a-f0-9]{64}', item) for item in ids), 'networks')
    raw = reader.docker('network', 'inspect', '--format',
                        '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"internal":{{json .Internal}},"ipam":{{json .IPAM.Config}}}',
                        *ids, stage='networks')
    rows = [json.loads(line) for line in raw.splitlines()]
    require(len(rows) == len(ids) and {row['id'] for row in rows} == set(ids), 'networks')
    return sorted(rows, key=lambda row: row['id'])


def volume_snapshot(reader):
    names = reader.docker('volume', 'ls', '--quiet', stage='volumes').splitlines()
    require(len(names) <= 500 and len(set(names)) == len(names) and
            all(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]*', item) for item in names), 'volumes')
    if not names:
        return []
    raw = reader.docker('volume', 'inspect', '--format',
                        '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"created":{{json .CreatedAt}}}',
                        *names, stage='volumes')
    rows = [json.loads(line) for line in raw.splitlines()]
    require(len(rows) == len(names) and {row['name'] for row in rows} == set(names), 'volumes')
    return sorted(rows, key=lambda row: row['name'])


def unit_binding(reader, unit):
    text = reader.run(['systemctl', 'show', unit, '--property=FragmentPath', '--property=DropInPaths'], 'scheduler')
    fields = dict(line.split('=', 1) for line in text.splitlines())
    fragment = UNITS[0] if re.fullmatch(r'fcd-support-operation@(backup|maintenance|health)\.service', unit) else unit
    require(fields == {'FragmentPath': '/etc/systemd/system/' + fragment, 'DropInPaths': ''}, 'scheduler')
    return fields


def scheduler_snapshot(reader, revision):
    """Preserve loaded commands, override absence and protected configuration."""
    result = {'files': {}, 'loaded': {}, 'commands': {}, 'timers': {}}
    config = HELD_ROOT / 'config/operations.env'
    require(config.parent.resolve(strict=True) == config.parent, 'paths')
    result['config'] = checked_file(config, 1000, 0o600, 65536)[1]
    for unit in UNITS:
        result['files'][unit] = checked_file(Path('/etc/systemd/system') / unit, 0, 0o644, 32768)[1]
        if unit != UNITS[0]:
            result['loaded'][unit] = unit_binding(reader, unit)
    for service in ('backup', 'maintenance', 'health'):
        unit = 'fcd-support-operation@' + service + '.service'
        result['loaded'][unit] = unit_binding(reader, unit)
        command = reader.run(['systemctl', 'show', unit, '--property=ExecStart', '--value'], 'scheduler')
        require_scheduler_binding(command, str(OLD_ROOT), revision, str(config), service)
        result['commands'][unit] = command
    for timer in UNITS[1:]:
        state = reader.run(['systemctl', 'show', timer, '--property=ActiveState', '--property=UnitFileState'], 'scheduler')
        require(set(state.splitlines()) == {'ActiveState=active', 'UnitFileState=enabled'}, 'scheduler')
        result['timers'][timer] = state
    return result


def inspect_server(revision):
    require(sys.platform == 'linux' and os.getuid() == 1000 and os.getgid() == 1000, 'native')
    require(revision == APPROVED_SOURCE and OLD_ROOT.resolve(strict=True) == OLD_ROOT, 'source')
    reader = Reader()
    git = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', str(OLD_ROOT)]
    old_revision = reader.run(git + ['rev-parse', 'HEAD'], 'source')
    require(re.fullmatch('[a-f0-9]{40}', old_revision) is not None, 'source')
    require(not reader.run(git + ['status', '--porcelain=v1', '--untracked-files=all'], 'source'), 'source')
    for directory in (HELD_ROOT, HELD_ROOT / 'state'):
        info = directory.lstat()
        require(directory.resolve(strict=True) == directory and stat.S_ISDIR(info.st_mode)
                and info.st_uid == 1000 and info.st_gid == 1000
                and stat.S_IMODE(info.st_mode) == 0o700, 'paths')
    job_path = HELD_ROOT / 'state/active-job'
    job_raw, job_fingerprint = checked_file(job_path, 1000, 0o600)
    job = parse_held_job(job_raw, HELD_PROJECT)
    require(job['JOB_REVISION'] == old_revision, 'source')
    before = container_snapshot(reader)
    require(job['JOB_CONTAINER'] not in {row['id'] for row in before}, 'journal')
    connected = {'/fcd-support-fcd-support-api-1', '/fcd-support-postgres-1', '/fcd-support-cloudflared'}
    require(connected <= {row['name'] for row in before if row['running'] is True}, 'containers')
    admins = [row for row in before if row['project'] == HELD_PROJECT and row['service'] == 'fcd-support-admin']
    require(len(admins) == 1, 'containers')
    admin = admins[0]
    project = 'fcd-support-host-test-p6-' + revision[:7]
    paths = [HOME_ROOT / ('fcd-support-successor-' + revision[:7]), HOME_ROOT / project]
    mounts = [mount['Source'] for row in before for mount in row['mounts'] if mount.get('Type') == 'bind']
    for path in paths:
        require(not os.path.lexists(path) and path.parent.resolve(strict=True) == path.parent, 'paths')
        require_disjoint(str(path), mounts)
    require(not reader.docker('image', 'ls', '--all', '--quiet', '--filter', 'reference=' + project + '-*', stage='source'), 'source')
    volume_rows = volume_snapshot(reader)
    network_rows = network_snapshot(reader)
    require_namespace_absent(project, before, network_rows, volume_rows)
    routes = json.loads(reader.run(['ip', '-j', 'route', 'show'], 'networks'))
    block = choose_block([entry['Subnet'] for row in network_rows for entry in row['ipam'] or [] if entry.get('Subnet')],
                         [row['dst'] for row in routes if row.get('dst') not in (None, 'default')])
    require(bool(block), 'networks')
    free_kib = int(reader.run(['df', '-Pk', '/var/lib/docker'], 'resources').splitlines()[-1].split()[3])
    disk_admitted = free_kib >= 12582912
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    memory_admitted = int(memory['MemAvailable'].split()[0]) >= 2097152
    scheduler = scheduler_snapshot(reader, old_revision)
    after = container_snapshot(reader)
    require_preserved(before, after, admin['id'])
    require(network_snapshot(reader) == network_rows and volume_snapshot(reader) == volume_rows, 'preservation')
    require(scheduler_snapshot(reader, old_revision) == scheduler, 'preservation')
    require(checked_file(job_path, 1000, 0o600)[1] == job_fingerprint, 'preservation')
    require(reader.run(git + ['rev-parse', 'HEAD'], 'source') == old_revision and
            not reader.run(git + ['status', '--porcelain=v1', '--untracked-files=all'], 'source'), 'preservation')
    return {'read_only_inspection_complete': True, 'held_journal_preserved': True,
            'recorded_actor_absent': True, 'connected_stack_running': True,
            'new_namespace_absent': True, 'network_block_available': True,
            'scheduler_source_binding_preserved': True,
            'private_admin_running': admin['running'] is True and admin['restarting'] is False,
            'private_admin_healthy': admin['health'] == 'healthy',
            'disk_capacity_admitted': disk_admitted, 'memory_capacity_admitted': memory_admitted}


def main(args, inspect=inspect_server, emit=print):
    try:
        result = inspect(inspect_arguments(args))
        require(isinstance(result, dict) and result and all(isinstance(value, bool) for value in result.values()), 'inspection')
        allowed = {'read_only_inspection_complete', 'held_journal_preserved', 'recorded_actor_absent',
                   'connected_stack_running', 'new_namespace_absent', 'network_block_available',
                   'scheduler_source_binding_preserved', 'private_admin_running', 'private_admin_healthy',
                   'disk_capacity_admitted', 'memory_capacity_admitted'}
        require(set(result) == allowed and all(value for key, value in result.items()
                                                if key not in ('private_admin_running', 'private_admin_healthy',
                                                               'disk_capacity_admitted', 'memory_capacity_admitted')), 'inspection')
        for key, value in result.items():
            emit('successor_' + key + '=' + str(value).lower())
        require(result['disk_capacity_admitted'] and result['memory_capacity_admitted'], 'resources')
        return 0
    except Refusal as error:
        emit('successor_preflight_refused_stage=' + error.stage)
    except Exception:
        emit('successor_preflight_refused_stage=inspection')
    return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
