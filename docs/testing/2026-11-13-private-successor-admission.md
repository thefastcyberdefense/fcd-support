# Private Successor Admission — 2026-11-13

## Disposition

Task 1 of the [successor rollout plan](../superpowers/plans/2026-11-13-private-test-successor-rollout.md)
is complete. Actual read-only SSH inspection passes the preservation checks and
**refuses deployment admission at `resources`**. This is not a deployment,
recovery, uncertainty settlement, dashboard-access proof or new launch-gate PASS.

Local base: `ba85e7731390bcbde850b65ae3997cf5ed448f89`. Accepted application
source pin: `5ede82cbabe046e9d1f00ef14727901f2555ae0d`.
Executed helper SHA-256: `7329f0ac1c4360e6f06100e8aad4f50866407b0272c79ce7c5c65b2c3399a1a1` (source-code fingerprint only).

## Implemented boundary

[The helper](../operations/actions/2026-11-13-private-successor.py) admits only
`--inspect <exact approved application revision>`. There is no deploy, delete,
retry, resolver or generic shell route. Commands are fixed read-only argv through
the Unix Docker endpoint, bounded by 15-second subprocess deadlines. Captured
output is checked against a 4 MiB limit before parsing; this is a post-capture
limit, not a streaming memory bound. No raw command body, error, environment,
credential, configuration, journal fingerprint or resource identifier is emitted.

The collector checks the complete protected uncertain-health record and its
private identity/content fingerprint, canonical disjoint absent target roots,
namespace collisions including foreign-labeled actors, unused target image tags,
network allocation, memory and disk requirements. Before/after comparisons cover
all observed container IDs/images/mounts/network attachments, network metadata,
volume identities, old clean source and protected scheduler configuration.

All three effective scheduled instances are checked for source/revision/config
command binding and absence of drop-ins. Root-owned template/timer bytes and
owner-only operations configuration are fingerprinted. The template itself is
not a loadable systemd instance; its file is preserved while the three actual
instances supply effective command proof. Only the already unhealthy admin's
running/restarting/health fields may naturally change; its identity, mounts and
attachments remain compared. Snapshots do not prove absence of transient
between-sample activity or changes to unprojected fields.

## Review and RED/GREEN evidence

Independent read-only review found three gaps in the first 14-test version:
configuration fingerprints were absent, only the health instance was inspected,
and network attachments were omitted. Authored controls failed before the
corrections; all three were fixed. Further controls exposed partial success
publication, decoy read tokens, timeout-body handling and namespace aliases.

Actual server collection initially refused at `containers`: a combined Docker
projection dereferenced missing `Health` map keys on actors without a health
check. Field/prefix probes isolated that boundary without publishing stderr.
The projection now uses guarded map indexing. A systemd probe then refused the
uninstantiated template; template file preservation and actual instance checks
replace that invalid query. Neither refusal was interpreted as a server fault.

Final command:

```text
python -B docs/operations/actions/2026-11-13-private-successor-test.py
25 passed, 0 skipped, 0 failed (0.010 seconds)
```

The tests use authored data, fake subprocess ports and mocked file metadata;
they do not run SSH, Docker or systemd. They cover the pure admission and
comparison boundaries, scheduler collection and closed publication, rather than
a full fake end-to-end `inspect_server` run. The real execution below supplies
separate current-host evidence. The same test command is added to the existing
hermetic operator-helper CI step; no new-head CI success is claimed here.

## Local validation

- `npm run validate:phase0`, `npm run format:check`, `npm run lint`,
  `npm run typecheck`, `npm run build`: exit 0.
- All seven hermetic Python suites in the updated CI step: 102 passed and
  4 platform skips across 106 cases; every command exits 0. New suite: 25 / 0.
- `node scripts/verify-security-policy.ts`: exit 0, 752 tracked files inspected;
  heuristic pattern coverage only.
- `node scripts/verify-pr-handoff.ts`: explicit `SKIP`, because no PR event is
  present; no enforced PR-structure validation is claimed.
- `git diff --cached --check`: exit 0. No new full Windows or Docker suite was
  executed for this Python/documentation change; earlier application CI remains
  separately attributed to 5ede82c in the corrected-harness review.

## Actual server execution

The exact helper was supplied on stdin to:

```text
ssh -T -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes redwan@192.168.10.40 'python3 -B - --inspect 5ede82cbabe046e9d1f00ef14727901f2555ae0d'
```

Final closed outcomes on November 13 (Asia/Dhaka):

```text
successor_read_only_inspection_complete=true
successor_held_journal_preserved=true
successor_recorded_actor_absent=true
successor_connected_stack_running=true
successor_new_namespace_absent=true
successor_network_block_available=true
successor_scheduler_source_binding_preserved=true
successor_private_admin_running=false
successor_private_admin_healthy=false
successor_disk_capacity_admitted=false
successor_memory_capacity_admitted=true
successor_preflight_refused_stage=resources
SSH exit 1; stderr absent
```

The helper may complete its read-only preservation observations while refusing
capacity admission. A false resource predicate still exits 1; it never authorizes
a later resource action. The held operation stays uncertain and cannot be
resolved merely because its recorded actor is absent.

Separate bounded read-only inventory used Docker `ps`/container/image metadata,
`df -Pk /var/lib/docker`, and protected top-level config/state files from FCD
test roots. Final inventory included all regular state records, including
`deployment-state` and `.record` files; the earlier partial extension-filtered
inventory was insufficient and was superseded. Only aggregate counts were
published:

- Docker filesystem: 10 whole GiB free, sampled shortfall **1,609 MiB** against
  12 GiB. Memory meets the 2 GiB admission minimum.
- 33 FCD-tagged images unused by current containers; 31 also referenced by
  retained operational configuration/state. Those references are preserved.
- Two images not referenced by that limited inventory have combined full-image
  size at most 1,481 MiB. This is an upper bound, not reclaimable-layer proof;
  even that bound is below the shortfall. Neither image was removed.
- 303 protected config/state records inspected privately. No contents or
  derived record fingerprints entered evidence.

A read-only storage probe identifies a Hyper-V guest and LVM root with ext4.
The corrected tree-shaped `lsblk` observation finds no additional 2 GiB of
unpartitioned capacity on the root disk and no 2 GiB gap between its parent
partition and root LV. These observations do not prove volume-group free space.
Earlier flat `lsblk` output could not establish disk ancestry and is not capacity
evidence. Unprivileged `vgs --readonly` returned an empty report; noninteractive
`sudo -n` for the same read-only inspection refused with `a password is required`.
No privileged LVM query or filesystem expansion succeeded.

## Controller compatibility, remaining action and rollback

The actual `deploy-runtime.sh`/`verify-runtime.sh` wrappers source their own
checkout's common controller. `operations-common.sh` derives `OPS_ROOT` from its
script directory and validates Git top-level, exact revision and clean status;
it does not hardcode the installed scheduler checkout. This is static source
proof of the independent-checkout route, not deployment execution. The convenience
synthetic harness and historical one-use final-server executor remain unsuitable.

No server file, image, volume, network, container, journal, socket, account,
scheduler, tunnel or provider mutation occurred. No rollback is needed. New
successor deployment, authentication and browser evidence remain pending. The
next server step needs sufficient disk capacity and a reviewed action; do not
lower the disk gate, delete referenced images, prune shared resources or alter
the held scope to obtain space. An operator can inspect LVM free capacity in
their terminal without exposing a password:

```powershell
ssh -t -o StrictHostKeyChecking=yes redwan@192.168.10.40 'sudo /usr/sbin/vgs --readonly --units g --noheadings -o vg_size,vg_free'
```

This only reports size/free-capacity numbers. It authorizes no resize or cleanup.
The operator enters the sudo password locally and shares only the capacity
numbers, never the password.
