"""One-use owner-authorized retirement of FCD test deployments only."""
import datetime
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

ENDPOINT = 'unix:///var/run/docker.sock'
HOME = Path('/home/redwan')
ACTION = HOME / 'fcd-support-retirement-20261116'
OLD_SCOPES = ['1fe31b5', '5d35777', '6d0210d', '6faff8b', '7af70cc', '8ccb9a0',
              '50abeb8', '50abeb8-diag', '67a4a4b', '91eb8f3', 'a6de436', 'b0ba255',
              'b1e183d', 'e0565d0', 'eed4695']
EXPECTED_ACTORS = {'fcd-support-host-test-p6-b1e183d-' + service + '-1'
                   for service in ['fcd-support-api', 'fcd-support-admin', 'fcd-support-reply', 'postgres']}
EXPECTED_ACTORS |= {'fcd-support-host-test-p6-b1e183d-ingress-peer', 'fcd-support-fcd-support-api-1',
                    'fcd-support-postgres-1', 'fcd-support-cloudflared'}
EXPECTED_VOLUMES = {'fcd-support-host-test-p6-' + scope + '-' + role
                    for scope in OLD_SCOPES for role in ['backups', 'postgres']}
EXPECTED_VOLUMES |= {'fcd-support-restore-host-test-p6-' + scope + '-data'
                     for scope in ['5d35777', '6faff8b', '8ccb9a0', '8ccb9a0-r2', '67a4a4b', 'b0ba255']}
EXPECTED_VOLUMES |= {'fcd-support-postgres-data', 'fcd-support-test_postgres_test_data'}

TIMERS = ['fcd-support-backup.timer', 'fcd-support-maintenance.timer', 'fcd-support-health.timer']
SERVICES = ['fcd-support-operation@backup.service', 'fcd-support-operation@maintenance.service', 'fcd-support-operation@health.service']
ROOT_PATTERN = re.compile(r'fcd-support-(?:host-test-p6-[a-f0-9]{7}(?:-diag)?|p6-(?:action|final)-[a-f0-9]{7}|validation-[a-f0-9]{7}|p6-timer-upgrade-20261103|retire-old-tests-20261103(?:-r2)?)')


class Refusal(Exception):
    pass


def require(value):
    if not value:
        raise Refusal('retirement_refused')


def is_fcd(value):
    return isinstance(value, str) and re.fullmatch(r'fcd-support(?:[-_][A-Za-z0-9_.-]+)?', value) is not None


def overlaps(left, right):
    first, second = PurePosixPath(left), PurePosixPath(right)
    return first == second or first in second.parents or second in first.parents


def select_plan(value):
    require(len(value['timers']) == 3 and all(row['active'] == 'inactive' and row['enabled'] == 'disabled' for row in value['timers']))
    require(len(value['services']) == 3 and all(state in ['inactive', 'failed'] for state in value['services']))
    actors = value['actors']
    require(len({row['id'] for row in actors}) == len(actors))
    require(all(re.fullmatch('[a-f0-9]{64}', row['id']) for row in actors))
    targets, protected = [], []
    for row in actors:
        selected = is_fcd(row['name']) or is_fcd(row['project']) or is_fcd(row['synthetic'])
        if selected:
            require(not row['project'] or is_fcd(row['project']))
            require(not row['synthetic'] or is_fcd(row['synthetic']))
            require(is_fcd(row['name']))
            require(bool(row['project'] or row['synthetic']) or row['name'] == 'fcd-support-cloudflared')
            targets.append(row)
        else:
            protected.append(row)
    target_ids = {row['id'] for row in targets}
    volumes = []
    for row in value['volumes']:
        if not (is_fcd(row['name']) or is_fcd(row['project']) or is_fcd(row['synthetic'])):
            continue
        require(is_fcd(row['name']) and (is_fcd(row['project']) or is_fcd(row['synthetic'])))
        require(not row['project'] or is_fcd(row['project']))
        require(not row['synthetic'] or is_fcd(row['synthetic']))
        require(row['driver'] == 'local' and row['scope'] == 'local' and not row['options'])
        require(not any(m.get('Type') == 'volume' and m.get('Name') == row['name'] for a in protected for m in a['mounts']))
        volumes.append(row)
    networks = []
    for row in value['networks']:
        if not (is_fcd(row['name']) or is_fcd(row['project']) or is_fcd(row['synthetic'])):
            continue
        require(is_fcd(row['name']) and row['driver'] == 'bridge')
        require(not row['project'] or is_fcd(row['project']))
        require(not row['synthetic'] or is_fcd(row['synthetic']))
        require(bool(row['project'] or row['synthetic']) or row['name'] == 'fcd-support-ingress')
        require(set(row['members']) <= target_ids)
        networks.append(row)
    images = []
    for row in value['images']:
        tags = row['tags'] or []
        if tags and all(is_fcd(tag.rsplit(':', 1)[0]) for tag in tags) and not any(a['image'] == row['id'] for a in protected):
            images.append(row)
    for root in value['roots']:
        path = PurePosixPath(root['path'])
        require(path.parent == PurePosixPath('/home/redwan') and ROOT_PATTERN.fullmatch(path.name) and root['canonical'])
        require(not any(m.get('Type') == 'bind' and overlaps(root['path'], m['Source']) for a in protected for m in a['mounts']))
        retired_volumes = {row['name'] for row in volumes}
        for volume in value['volumes']:
            if volume['name'] in retired_volumes: continue
            options = volume.get('options') or {}
            sources = []
            if set((options.get('o') or '').split(',')) & {'bind', 'rbind'}:
                device = options.get('device')
                require(isinstance(device, str) and PurePosixPath(device).is_absolute())
                sources.append(device)
            if volume.get('canonical_bind_source'): sources.append(volume['canonical_bind_source'])
            require(not any(overlaps(root['path'], source) for source in sources))
    return {'actors': targets, 'volumes': volumes, 'networks': networks, 'images': images,
            'roots': value['roots'], 'protected_actor_ids': sorted(row['id'] for row in protected)}


def resource_commands(plan, command):
    for row in plan['actors']:
        command(['container', 'stop', '--time', '-1', row['id']])
        command(['container', 'rm', row['id']])
    for row in plan['networks']:
        command(['network', 'rm', row['id']])
    for row in plan['volumes']:
        command(['volume', 'rm', row['name']])
    for row in plan['images']:
        for tag in row['tags']:
            command(['image', 'rm', tag])


class Reader:
    def run(self, args, timeout=30):
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout,
                                env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(HOME), 'LC_ALL': 'C'})
        require(result.returncode == 0 and len(result.stdout) <= 4194304 and len(result.stderr) <= 1048576)
        return result.stdout.strip()

    def docker(self, *args):
        return self.run(['docker', '--host', ENDPOINT, *args], timeout=80 if args[:2] == ('container', 'stop') else 30)

    def snapshot(self):
        ids = self.docker('ps', '--all', '--quiet', '--no-trunc').split()
        require(len(ids) <= 500)
        fmt = '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"synthetic":{{json (index .Config.Labels "fcd-support.synthetic-host-test")}},"image":{{json .Image}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}'
        actors = [json.loads(line) for line in self.docker('container', 'inspect', '--format', fmt, *ids).splitlines()] if ids else []
        for row in actors:
            row['name'] = row['name'].lstrip('/')
            row['project'] = row['project'] or ''
            row['synthetic'] = row['synthetic'] or ''
        volumes = []
        for name in self.docker('volume', 'ls', '--quiet').split():
            fmt = '{"name":{{json .Name}},"project":{{json (index .Labels "com.docker.compose.project")}},"synthetic":{{json (index .Labels "fcd-support.synthetic-host-test")}},"driver":{{json .Driver}},"scope":{{json .Scope}},"options":{{json .Options}},"created":{{json .CreatedAt}}}'
            row = json.loads(self.docker('volume', 'inspect', '--format', fmt, name))
            options = row.get('options') or {}
            if set((options.get('o') or '').split(',')) & {'bind', 'rbind'}:
                device = options.get('device')
                require(isinstance(device, str) and Path(device).is_absolute())
                row['canonical_bind_source'] = str(Path(device).resolve(strict=True))
            volumes.append(row)
        networks = []
        for ident in self.docker('network', 'ls', '--quiet', '--no-trunc').split():
            fmt = '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Labels "com.docker.compose.project")}},"synthetic":{{json (index .Labels "fcd-support.synthetic-host-test")}},"driver":{{json .Driver}},"members":{{json .Containers}}}'
            row = json.loads(self.docker('network', 'inspect', '--format', fmt, ident))
            row['members'] = sorted(row['members'])
            networks.append(row)
        images = []
        for ident in sorted(set(self.docker('image', 'ls', '--quiet', '--no-trunc').split())):
            images.append(json.loads(self.docker('image', 'inspect', '--format', '{"id":{{json .Id}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}}}', ident)))
        timers = []
        for unit in TIMERS:
            raw = self.run(['systemctl', 'show', unit, '--property=ActiveState', '--property=UnitFileState'])
            fields = dict(line.split('=', 1) for line in raw.splitlines())
            timers.append({'active': fields['ActiveState'], 'enabled': fields['UnitFileState']})
        services = [self.run(['systemctl', 'show', unit, '--property=ActiveState', '--value']) for unit in SERVICES]
        roots = []
        for path in HOME.iterdir():
            if ROOT_PATTERN.fullmatch(path.name):
                info = path.lstat()
                roots.append({'path': str(path), 'canonical': path.is_dir() and not path.is_symlink() and path.resolve() == path and info.st_uid == 1000,
                              'device': info.st_dev, 'inode': info.st_ino})
        return {'actors': actors, 'volumes': volumes, 'networks': networks, 'images': images,
                'timers': timers, 'services': services, 'roots': roots}


def atomic_record(path, value):
    temporary = path.with_suffix('.next')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def execute(reader):
    require(sys.platform == 'linux' and os.getuid() == os.getgid() == 1000 and HOME.resolve() == HOME)
    before = reader.snapshot()
    plan = select_plan(before)
    require({row['name'] for row in plan['actors']} == EXPECTED_ACTORS)
    require({row['name'] for row in plan['volumes']} == EXPECTED_VOLUMES)
    for network in plan['networks']:
        require(network['name'] in ['fcd-support-data', 'fcd-support-ingress', 'fcd-support-test_data'] or
                any(network['name'].startswith('fcd-support-host-test-p6-' + scope + '-') for scope in OLD_SCOPES) or
                any(network['name'] == volume for volume in EXPECTED_VOLUMES if volume.startswith('fcd-support-restore-')))
    require(not ACTION.exists() and not ACTION.is_symlink())
    ACTION.mkdir(mode=0o700)
    record = {'phase': 'intent', 'started': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'plan': plan, 'completed': []}
    atomic_record(ACTION / 'retirement.json', record)
    protected = {row['id']: row for row in before['actors'] if row['id'] in plan['protected_actor_ids']}
    try:
        # Bind one final admission snapshot before the first destructive action.
        require(reader.snapshot() == before)
        def perform(args):
            kind, action = args[:2]
            target = args[-1]
            if kind == 'volume':
                expected = next(row for row in plan['volumes'] if row['name'] == target)
                volume_format = '{"name":{{json .Name}},"project":{{json (index .Labels "com.docker.compose.project")}},"synthetic":{{json (index .Labels "fcd-support.synthetic-host-test")}},"driver":{{json .Driver}},"scope":{{json .Scope}},"options":{{json .Options}},"created":{{json .CreatedAt}}}'
                require(json.loads(reader.docker('volume', 'inspect', '--format', volume_format, target)) == expected)
                require(not reader.docker('ps', '--all', '--quiet', '--filter', 'volume=' + target))
            elif kind == 'network':
                require(reader.docker('network', 'inspect', '--format', '{{len .Containers}}', target) == '0')
            elif kind == 'image':
                expected = next(row['id'] for row in plan['images'] if target in row['tags'])
                require(reader.docker('image', 'inspect', '--format', '{{.Id}}', target) == expected)
                require(not reader.docker('ps', '--all', '--quiet', '--filter', 'ancestor=' + expected))
            elif action == 'rm':
                require(reader.docker('container', 'inspect', '--format', '{{.State.Running}}', target) == 'false')
            reader.docker(*args)
            record['completed'].append({'kind': kind, 'action': action, 'target': target})
            atomic_record(ACTION / 'retirement.json', record)
        resource_commands(plan, perform)
        after = reader.snapshot()
        require({row['id']: row for row in after['actors']} == protected)
        require(not select_plan(after)['actors'] and not select_plan(after)['volumes'] and not select_plan(after)['networks'])
        for root in plan['roots']:
            path = Path(root['path']); info = path.lstat()
            require(path.resolve() == path and not path.is_symlink() and (info.st_dev, info.st_ino) == (root['device'], root['inode']))
            shutil.rmtree(path)
            record['completed'].append({'kind': 'fixture_root', 'action': 'remove', 'target': str(path)})
            atomic_record(ACTION / 'retirement.json', record)
        record['phase'] = 'complete'; atomic_record(ACTION / 'retirement.json', record)
        print('test_retirement_complete=true')
        print('unrelated_containers_preserved=' + str(len(protected)))
        print('retired_containers=' + str(len(plan['actors'])))
        print('retired_volumes=' + str(len(plan['volumes'])))
        print('retired_networks=' + str(len(plan['networks'])))
        print('retired_fixture_roots=' + str(len(plan['roots'])))
    except Exception:
        record['phase'] = 'uncertain'; atomic_record(ACTION / 'retirement.json', record)
        raise


def main(args):
    try:
        require(args in [['--inspect'], ['--retire-all-test-data']])
        reader = Reader()
        if args == ['--inspect']:
            plan = select_plan(reader.snapshot())
            print('retirement_admitted=true')
            for kind in ['actors', 'volumes', 'networks', 'images', 'roots']:
                print('retirement_' + kind + '=' + str(len(plan[kind])))
        else:
            execute(reader)
        return 0
    except Exception:
        print('test_retirement_refused=true')
        return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
