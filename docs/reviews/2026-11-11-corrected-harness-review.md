# Corrected harness review and current server checkpoint

Date: 2026-11-11 (Asia/Dhaka). Primary base:
`304b64c1ee3a551a9ea9cd07d145ca45a0de0895`.

## Submitted heads and independent disposition

AGY submitted PR #18 at 9bacf5e and PR #19 at a9a24ef. Each exact head had
18 successful checks including aggregate CodeQL. Independent review confirmed
material progress but found remaining ownership/publication defects. Codex
corrected these directly rather than delegating another broad implementation.

PR #18 candidate `c12716f7badcf7012b8ba55358ce0befce1c0527` freezes live,
previously captured group anchors before admitting unknown MSYS members;
recycled group IDs alone cannot authorize termination. Both regression roots
are reaped independently, and short capture budgets are not extended to
1,500 ms. A new recycled-group RED fails before correction. The lifecycle
suite passes 24 / 1 skip; fresh full four-worker check passes **2,228 / 461
skips**, 135 files, **241.18 seconds** (whole command 288.10 seconds), with
unchanged source diff. Submitted 9bacf5e's independent full run had **2,221 /
461 skips / 6 failures**; that result is retained without a causal timing claim.
See `../testing/2026-11-11-codex-windows-ownership.md`.

PR #19 candidate `d0a65df5b2c26373d5d771ba442c75b1b39b29b3` binds operation
cleanup to complete protected-journal identity and exact actor labels/name,
registers returned fixture IDs before inspection, and compares volume creation
metadata with independent expected ownership checks. Unknown actors/replaced
volumes are preserved and fail the gate. Synchronous private-output capture
covers setup plus final EXIT cleanup before closed publication. Original three
RED controls and additional foreign-metadata/cleanup-lifetime controls are
retained. Final two-file verification passes **24 / 0 skips**, **18.25 seconds**.
An earlier co-run had 23 passes / one 3,500 ms Windows timeout; the exact control
and final co-run subsequently pass without deadline or assertion changes.
Independent correction reviews found no additional blocker. See
`../testing/2026-11-11-codex-health-fixture-ownership.md`.

PR #18 is accepted as merge `f6ca679bf41b200d83c516cc2895d42c416a2285`
after all five applicable PR workflows and all 18 check-rollup entries pass.
Final CI 43022574035 reports **2,292 / 397 skips**, 135 files, **94.98 seconds**;
quality/security 43022574143, CodeQL 43022574249, PostgreSQL/native 43022574047
and four-lane recovery runtime 43022574243 pass. Merge and tested-source trees
both equal `887bf8dd6b23f5667ea5c087885e8f8a8cabf989`.
PR #19 final acceptance is recorded below. Earlier AGY CI is not attributed to the corrected source. No full
local PR #19 suite or native Docker/database execution is inferred from its
focused Windows checks. Phase 0, formatting, lint, strict typecheck, build,
pattern-scanner and whitespace checks pass before publication of each branch.

## Final-head PR 19 execution evidence

Exact d0a65df CI 43023022984 passes **2,304 / 393 skips**, 137 files,
**110.90 seconds**. Quality/security 43023023006 and CodeQL 43023023134 pass,
including aggregate CodeQL 130531514548. Native 43023022993 passes: its
separate suites report 1,353 unit checks, 145 / 1 skip PostgreSQL checks,
252 restore checks and 47 further PostgreSQL checks. The actual six health
stdio PostgreSQL tests pass, and all four Docker health-stdio outcomes are true.
These lanes are not summed or attributed to the deployed server. Runtime
43023022989 passes all four lanes, and all 18 check-rollup entries including
push and aggregate CodeQL succeed. PR #19 is accepted as merge
`2e24997a95d941945c1b535ac0977dc2b35fffea` with expected head d0a65df. The
predicted conflict-free combined tree and actual merge tree are both exactly
`eec1cad8362c05cf2efae4e37bebd8f367bdd078`. The two patches touch separate
files; their shared helper interaction receives a combined local gate.

## Actual read-only server observation

SSH to the authorized local test server confirms the latest private scope's
saved operation is still **health / uncertain**, with its recorded actor absent.
The journal's device/inode/mtime/size/content fingerprint matches before and
after inspection. Actor absence does not establish success, rollback or SQL
settlement. No saved record was cleared, retried or altered.

The private scope has four runtime containers: webhook, reply and PostgreSQL
are running/healthy; admin is restarting/unhealthy. A bounded last-60-line
admin log sample contains 60 startup-failure markers. The admin Unix socket
exists with expected UID/GID 1000:1000 and mode 0600 but refuses connections.
These observations do not establish the startup failure's internal cause.
No socket, container, service, timer, permission, network or server file was
changed. No raw logs, IDs, credentials or application content were published.

## Next operational work

After source acceptance, prepare a concrete reviewed server disposition and
rollout using the existing approved test-deployment boundaries. Preserve the
uncertain journal and its volumes, the connected older Meta test webhook stack
and every unrelated project. A new isolated test scope is an available planning
option; no fresh-scope deployment, current-scope retry, socket deletion, resolver,
backup replay, daemon restart or live Meta/Manifest action is authorized by a
CI result or by this evidence document alone. Codex retains that disposition.

## Supported recovery-path assessment

Independent source review confirms that current public lifecycle and scheduled
commands reject the held scope's active-job before dispatch. Socket recovery
also requires the exact admin actor exited/not-running/not-restarting; the
confirmation flag does not stop it. No current public command grants journal
settlement authority, and the internal resolved transition is not a public
resolver. Direct socket removal or a hidden state rewrite is not a rollout.

The successor plan should use a fresh private-disabled scope with an independent
accepted source checkout, new roots/volumes/namespace and freshly admitted
nonoverlapping networks. Invoke the implemented public controllers from that
new checkout through a committed reviewed executor. The existing convenience
host harness requires its historical hardcoded source root; do not loosen that
guard or pretend it admits a separate checkout. The old final-server executor
also requires absent host units and historical pins and cannot be replayed.

Preserve the installed scheduler's existing checkout/revision/config binding,
unit bytes/status, every held journal/storage/socket, the connected older Meta
webhook stack and unrelated projects. A new checkout avoids silently changing
revision-bound scheduler scripts. Before actual execution, bind exact source,
images, ownership, paths and network admission; make a one-use intent marker,
verify before/after preservation and stop on any unexpected drift. A fresh
scope needs its own reviewed authentication setup and browser verification;
it does not migrate or erase held accounts/data, settle the old job or switch
the public callback. No such server mutation occurred in this review.

AGY can independently consolidate the existing Phase 7 operator test procedure
using `../handoffs/2026-11-11-antigravity-phase-7-runbook.md`. It is documentation
only and grants no server or external execution authority.

## Combined-source startup/ownership integration correction

The first combined four-worker gate at 2e24997 fails **3 tests / 2,249 passed /
461 skips**, 137 files, **257.48 seconds** (whole command 307.40 seconds).
Fast malformed/oversized/invalid-config health children exit before asynchronous
Windows ownership capture completes. The stricter helper correctly refuses to
confirm an uncaptured exited tree; neither independent PR gate had exercised
this shared-helper combination.

Direct test-fixture correction `5ede82cbabe046e9d1f00ef14727901f2555ae0d`
uses a separate IPC startup gate to keep the actual Node actor alive until
ownership is captured. That same PID then disconnects IPC and imports the
unchanged built health entrypoint with actual argv; stdin framing, output,
nonzero/zero exit and process-tree assertions remain unchanged. Capture and
health waits share the existing 3,500 ms execution budget. No new timeout,
assertion removal, skip, retry, production code or recovery authority is added.
Independent review finds no blocking issue, including real module entry and
natural exit behavior. The existing 13 health regression tests pass in
**21.27 seconds** after the shared-budget correction; lint, strict typecheck,
build, pattern and whitespace checks pass. Fresh full local and exact-source
GitHub validation follow this implementation checkpoint.

## Source verification and closeout, 2026-11-13

All five push workflows on exact implementation 5ede82c completed successfully:
CI 43028182541, CodeQL 43028182335, quality/security 43028182438,
PostgreSQL/native 43028182343 and four-lane runtime 43028182480. All ten commit
check runs succeed. CI reports **2,316 / 397 skips**, 137 files, **109.31 seconds**.
Native's separate lanes report 1,355 unit tests, 145 / 1 skip PostgreSQL tests,
252 restore checks and 47 further checks, with all four health-stdio Docker
outcomes true. These are separate proofs, not summed or deployed-server results.

The final four-worker Windows run at 5ede82c records **2,250 passes / 461 skips /
2 failures**, 137 files, **250.24 seconds** (whole command 299.21 seconds).
Backup failed-init/interrupted-barrier and closed-stdio MSYS descendant cleanup
refuse confirmation. The startup gate fixes the earlier three health failures,
but four-worker Windows capture consistency remains an open development issue.

The interrupted two-worker run produced no retained result and is not claimed.
Fresh 2026-11-13 `VITEST_MAX_WORKERS=2 npm run check` on the same implementation
passes Phase 0, formatting, lint, strict typecheck, build and **2,252 tests /
461 skips**, 137 files, **302.93 seconds** (whole command **358.88 seconds**).
The tracked diff is unchanged throughout that check. A different worker profile
is not evidence that the four-worker issue is solved or caused by machine load.
No timeout, assertion or skip was changed to obtain the two-worker result.

The November 11 read-only observation also confirms all three connected older
test-stack containers present/running; external delivery remains unverified.
No November 13 server state or successful dashboard recovery is inferred from
that earlier observation.

AGY's two bounded next assignments are the Phase 7 runbook and Windows capture
consistency checklists under docs/handoffs. Codex's concrete next operational
sequence is `../superpowers/plans/2026-11-13-private-test-successor-rollout.md`;
its first task is a tested read-only admission executor, followed by separately
reviewed one-use fresh deployment. Existing local-test authorization is retained;
production, live-provider and uncertainty-settlement boundaries are unchanged.
