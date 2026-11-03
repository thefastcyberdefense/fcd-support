# Phase 6 Task 16 closeout

Date: 2026-11-03 (Asia/Dhaka).
Decision: **COMPLETE — approved private local-server deployment and handoff passed.**
Phase 6's planned implementation, local validation and separately authorized
test-server delivery are complete. This does not pass Phase 7 or authorize
production/live integration.

## Source, review and publication

Deployed application: `24e56679c9c29823b210ca6991608f83de556156`, PR #8 merge.
Its full tree equals reviewed/tested `3c5959642d6ce4247d838d1b013298fbf26fe56e`.
The final full gate passed **1,968 tests / 446 platform skips**, 131 files,
253.76 s, plus phase-0 validation, formatting, lint, strict types and build.
The real read-only socket matrix passed **68 native tests**.

All four exact-head workflows passed: CI 41609801292, CodeQL 41609801294,
PostgreSQL/native 41609801218 and private runtime 41609801270. Both actual
disposable runtime lanes passed deployment, private HTTP, maintenance, backup,
health, checkpoint, restore, promotion, compatible rollback, recovery and
owned cleanup. Links and retained failed iterations are in
`2026-11-03-task-16-timer-repair.md` and
`../testing/2026-11-03-scheduled-readonly-socket.md`.

The concrete upgrade/root actions and their independent reviews were published
at `a08fb11` before mutation. Their final Linux hermetic guards passed
**8 upgrade + 9 repair tests**, without executing entrypoints, with scratch
removed. The existing-admin recheck was independently reviewed, passed four
credential-envelope tests and was published at `867792b` before execution.
These counts describe distinct lanes; they are not added to the full gate.

## Actual server results

The one-use managed upgrade ran on the existing synthetic project
fcd-support-host-test-p6-b1e183d. It preserved its physical PostgreSQL/volume
identity, schema, roots, secrets and synthetic admin identity. Public deploy/
verify, all three scheduled job groups and exact unit rendering passed. Actual
existing password/MFA, authenticated dashboards, logout/session revocation and
bounded SSH-client reaping also passed. Credentials remained in the original
private server file and client process memory; none entered output or Git.

The owner then authenticated sudo only in their SSH terminal and ran the exact
reviewed root repair once. Its SHA256 is
`80efc0052ebff2bb270c1d40e5df6a7780dd7026ebae9fe330a85863b453725f`.
All three actual service executions passed while persistent RefUnit references
retained their fresh start/result evidence. Only afterward were the three
timers enabled and started. The root command returned:

- task16_exact_timer_generation_repaired=true.
- task16_real_scheduled_services_passed=true.
- task16_three_timers_enabled_active=true.

Independent read-only inspection verified the root-owned mode-0644 completion
record, accepted source, exact four installed hashes and the three recorded
service/timer outcomes. The service hash is
`ffcd3f695df0073e8cb34012704787667088aabbbef005499dec4a668150ee37`;
all three timer hashes are unchanged. Installed files are root-owned mode 0644.
All timers are enabled/active with next activations present and no drop-ins.
Effective service UID/GID 1000, read-only home/strict system protection,
NoNewPrivileges, AF_UNIX restriction, 256 MiB and 128-task bounds match the
reviewed generation. Configurable renderer inputs remain unchanged.

After references are released, systemd may unload idle oneshots and reset their
execution fields. Idle defaults are not fresh success evidence. Actual service
proof comes from the helper's pinned verification, owner command outcome and
matching root-owned completion record.

A separate post-root public runtime verification passed with **zero preflight
lock-refusal retries**. READY/accepted source and the original qualification
anchor were verified. Strict other-project inventory/state/volume/network/
host-pin comparison against the fresh raw baseline passed. No root repair was
replayed, no uncertain job was cleared and no absent actor was treated as SQL
settlement. Actual details: `../testing/2026-11-03-phase-6-server-24e5667.md`.

## Preservation and operational handoff

Original historical loss/uncertainty records remain OPEN and contained. The
November 3 five-actor lifecycle observation is recorded without cause
attribution in `../operations/incidents/2026-11-03-pre-upgrade-lifecycle-window.md`.
The immutable original baseline and separate qualification remain. The one-off
qualification was never used during or after deployment; those comparisons
used the new raw baseline strictly.

Keep every old uncertain scope, volume, retained image, journal and baseline.
The old b1e183d root attempt and its bytes/start marker remain historical. The
new root start/completion records are retained. **Do not replay either one-use
installer or deployment action.** A later deployment/rollback must coordinate
revision-pinned timers and the public owning controllers under a new concrete
reviewed action; uncertainty is a stop condition.

Current private configuration/state/socket remain under
`/home/redwan/fcd-support-host-test-p6-b1e183d`. The remote admin socket is
`socket/admin.sock` under that root, reached only through a checked SSH loopback
forward on 127.0.0.1:13004. No admin TCP listener/host port was introduced.
Host-global Node was not upgraded; application/operations use the pinned
container toolchain. No other-project resource or daemon/host restart was
targeted. Operator guides: `../operations/phase-6-server-deployment.md`,
`../operations/phase-6-root-timers.md` and `../operations/test-deployment.md`.

## Phase 7 handoff

The existing admission/test webhook stack was preserved; it was not silently
switched to this private runtime. Model/outbound/n8n execution remain false.
Phase 7 still owns current Manifest recording-off attestation, dedicated
fcd-support/auto network/provider proof, real Meta test-asset quality/sends,
controlled ingress transition and full-host outage/restart evidence, subject to
the existing action boundaries. Production promotion remains outside this plan.

AGY can start the independently scoped health-transport stress assignment and
the docs-only Phase 7 readiness matrix. Both have checkboxes/acceptance criteria:
`../handoffs/2026-11-03-antigravity-health-transport-stress.md` and
`../handoffs/2026-11-02-antigravity-phase-7-readiness.md`. Codex retains review,
merge and operational authority. No new owner approval is invented by closeout.
