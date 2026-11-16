# Retire test deployments and deploy private version 1

> Execute inline using the executing-plans skill. Owner approval: the November 16 chat explicitly selects retirement of every FCD test stack, database, backup and FCD timer, followed by deployment and an unfinished-work record.

## Scope and decisions

- This decision supersedes historical test-stack/recovery-evidence preservation for retirement only. Deleting an uncertain test scope does not establish the outcome of its old jobs.
- Preserve production WhatsApp registration/assets, all non-FCD projects, shared Docker daemon settings, global caches and installed repository source. Do not issue Meta, Manifest, n8n, DNS or remote tunnel-management calls.
- Stop the old local test tunnel with its stack. No replacement public tunnel is authorized by this first private deployment.
- Deploy accepted main application c2d8225d2a096e2d4f406c35f8ab170a6dad2f80 from a new immutable checkout. Do not merge draft PR22/23/24 or deploy their unaccepted combination.
- Fresh PostgreSQL and secrets; MODEL_EXECUTION_ENABLED=false, OUTBOUND_EXECUTION_ENABLED=false and N8N_EXECUTION_ENABLED=false. Existing public lifecycle deploy/verify controllers only; no internal state edits or outcome replay.
- Keep admin on its private Unix socket and an owned SSH loopback forward. No admin TCP host publication.

## Sequence and evidence

- [ ] Operator disables/stops the three FCD timers and three operation instances. Independently verify inactive services and disabled timers before retirement. Interactive sudo credentials never enter chat or tool arguments.
- [ ] Add an exact, one-use retirement executor and authored fake-port controls. Bind current Docker IDs, project/synthetic labels, named volumes, networks and FCD-only image tags. Reject resources used by foreign containers, symlinks/aliased roots, active schedulers, changed facts and repeated execution.
- [ ] Commit/push reviewed executor before server mutation. Record private owner-only intent and checkpoints. Stop/remove only admitted FCD containers, then their unused owned networks/volumes and exclusive test images. No prune, rm --force, volume force, daemon restart or global filesystem delete.
- [ ] Remove only canonical enumerated old FCD fixture roots after their resources are absent; explicitly exclude unrelated mounts/source and the new action/deployment roots. Preserve a content-free retirement audit, not old credentials or payloads. Compare all unrelated container/storage/network facts before/after.
- [ ] Recheck unchanged admission floor: 12 GiB Docker filesystem free and 2 GiB available memory. Record actual reclaimed space, not summed image sizes.
- [ ] Prepare a fresh immutable source checkout and fresh private fixture with the existing generator. Build the three pinned image definitions, generate offline age keys, create disjoint scoped networks/backup storage and the required bounded ingress peer. Use a one-use intent; stop on ambiguity without automatic retry.
- [ ] Invoke deploy-runtime.sh and verify-runtime.sh with exact source and private-disabled mode. Verify healthy private services, Unix login route and zero host published application/admin ports. Record provider execution remains disabled.
- [ ] Provision/verify first private administrator using existing bootstrap API with credentials generated/stored only in protected server memory/storage or the operator's masked terminal. Verify login/MFA/dashboard/logout without credential or cookie output.
- [ ] Establish owned SSH loopback access and document operator access/setup instructions without secrets.
- [ ] Update the current tracker/context and a dated results/unfinished-work record with exact outcomes and boundaries; commit/push completed changes. Keep P7/P8 and production gates blocked unless their own evidence is actually satisfied.

## Unfinished work to preserve explicitly

PR24 copy-boundary corrections; unresolved solo four-worker Windows failures; formal P1 gate record; signed synthetic probes and aggregate proof tooling; reviewer/resume/privacy/consent/template controls and production correction handlers; multi-role provisioning; reviewed enabled-worker lifecycle; T-01 through T-11 and independent bilingual scoring; Meta permissions/token ownership/coexistence/manual-echo proof; privacy/consent disclosures; backup/alert/manual-coverage ownership; separately approved production plan. Operator inbox/staff UI, public Trust Center and direct notifications remain unapproved proposals.

## Rollback and failure

Retirement is destructive and owner-authorized; no recovery of deleted test databases/backups is promised. Partial retirement/deployment stops with a private action checkpoint and closed diagnostics. Do not replay failed one-use deployment or fabricate successful recovery. Retiring old tests does not authorize production-number changes or live provider calls.

## Recorded graceful-stop timeout and bounded completion

The original one-use retirement removed five private containers, then its legacy
webhook API stop remained unacknowledged after 80 seconds. No volume/network/image
or directory deletion occurred. Preserve that action's uncertain checkpoint.

A separate one-use completion binds the exact original three legacy IDs, images,
mounts and networks, confirms the other five removal acknowledgements and the
same protected actor IDs, and uses Docker stop with a 30-second timeout for those
three IDs only (Docker may then send SIGKILL). This is covered by the owner's
explicit full test retirement, not a recovery-success inference. No rm --force,
global kill, state-marker reset or old one-use action replay is permitted. The new
completion record, plus actual old resource absence, becomes deployment admission
proof. The original uncertain checkpoint remains unchanged.

## Prepared-source deployment attempt

Retirement completion passed: 8 total old containers, 38 volumes, 70 networks,
53 images and 25 fixture/action roots retired; 23 unrelated containers preserved.
Post-retirement Docker free space was 21,294 MiB. No old FCD resources remained.

The first fresh deployment cloned and pinned the source successfully, then
refused at fixture construction because its restricted PATH omitted the host's
existing Node binary. No fixture or deployment service was created. Preserve
that uncertain attempt record. A separately marked R2 may reuse only that exact
clean prepared source after matching the original pre-resource failure record,
checking namespace/path/image absence and all admission floors again. Verify the
absolute existing Node 24.16.0 binary for fixture generation before intent;
application compilation/runtime still use the unchanged pinned Node 24.18.0
container definitions. No host npm validation or container version downgrade.
Use --inspect-prepared-source / --deploy-prepared-source with a new R2 action
root; never replay --deploy or delete its old action marker.
