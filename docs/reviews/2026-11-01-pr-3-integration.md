# PR #3 integration review

Date: 2026-11-01 (Asia/Dhaka).
Reviewed correction: `78013148751a493a6f8859bc6d3ee9628cb954d6`.
PR: <https://github.com/thefastcyberdefense/fcd-support/pull/3>.

Decision: **PR #3 accepted and squash-merged as
`df8e52dbe59e0013ab28a5790b21c9785324b2f0`.** Its complete tracked tree equals
the validated correction exactly. Task 15's documentation closeout and P6-GATE
remain open; this is not an aggregate phase approval.

## Accepted implementation and proof scope

AGY supplied real kernel-EROFS backup refusal with a writable control, owning
scheduler/preflight flock contention, real PostgreSQL catalog deduplication,
and a seeded older-snapshot/provider-ledger outbox test. The same functioning
provider supplies an eligible control in a separate unfenced database; the
restored fixture's recovery hold remains active. This is seeded snapshot-state
coverage, not a newly executed physical restore. Existing real encrypted
two-cluster and historical server drill evidence remains separate.

Codex reproduced and repaired the remaining cleanup defects on the existing
PR branch. Two child false-success assertions failed before the repair. Nine
shell admission/cleanup regressions failed before the repair; the successful
control now confirms exact owned resource removal. Cleanup rejects unresolved
termination, waits for stream closure, and reaps explicitly detached Unix
process groups, including descendants inheriting deployment.lock. Docker
cleanup requires successful inventories, default volume options and the
acknowledged initializer ID/image/mount binding. Refused admission makes no
initializer call, failed initialization is cleaned by exact ID, and cleanup
errors fail the gate rather than producing success.

One intermediate Linux CI unit run at `446e54b` failed because the new embedded
descendant-test script had incorrect newline escaping. That failure is retained;
it was not rerun away. The minimal fixture correction at `7801314` passed all
13 process-lifecycle tests on local Docker Desktop (1.53 s). The owning native
scheduler suite also passed 68 tests (3.01 s); local backup-test actor, volume
and network audit counts were all zero. These local native runs used their
reviewed working correction trees; final-source CI is recorded separately.

The earlier `938981c` Windows gate independently passed 1,939 tests / 437
platform skips in 258.59 s. The `446e54b` Windows gate independently passed
1,952 / 438 skips across 131 files in 253.12 s, including build. Earlier `b3831b0`
full-gate timeouts and focused reruns remain in the correction review; they are
not reported as successful full validation.

A separate read-only reviewer accepted the immutable final correction with no
Important/Critical findings, conditional on final-source validation. Git proves
the src/infra/package tree still equals deployed application `67a4a4b`; the only
script differences from that source are the two test harnesses. This change
does not require claiming a new server deployment.

## Final-source validation

`VITEST_MAX_WORKERS=4 npm run check` at the final correction exited 0:
**1,952 passed / 438 platform skips**, 131 files, **259.95 s**. Phase 0, format,
lint, strict type checking and build pass.

Final-source CI unit validation passed **2,020 / 370 lane skips**, 131 files,
90.26 s, with real Docker projections and all five hermetic Python suites.
The suites passed separately: observer **33** (0.472 s), reboot **11** (0.017 s),
peer **11** (0.013 s), rollback **6** (0.009 s), current runtime **5** (0.168 s).
These overlapping suites are not distinct coverage totals. Full PostgreSQL
passed **621 / 52 lane skips**, 56 files, 119.09 s. CodeQL and both fresh/
precreated private-runtime jobs pass. The final native/grants/restore job also
passed, with overlapping lane results recorded separately:

- Native units: **1,298 passed**, 55 files, 457.95 s.
- Grants PostgreSQL: **139 passed / one restore-only skip**, 13 files, 60.00 s.
- Restore units: **252 passed**, 12 files, 59.61 s.
- Two-cluster integration: **47 passed**, two files, 27.29 s.

All four exact correction-source workflows passed:
[CI](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41320435620),
[CodeQL](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41320435609),
[PostgreSQL/native](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41320435615),
[private runtime](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41320435605).
The fresh/precreated runtime jobs use disposable GitHub runners, not the
owner's server. Later main/documentation workflows are distinct and must not
be represented as passed merely from these results.

The integration documentation corrects one remaining historical full commit
reference through `git rev-parse fd60612^{commit}`. References to removed
nonexistent files in the results artifact are explicitly historical corrections,
not assertions that those paths exist.

## Remaining Phase 6 work

The bounded failure-test/CI/harness work is accepted. Task 15 still needs the
original plan's operator-guide, acceptance and
threat-model evidence consolidation, followed by Codex's independent aggregate
gate decision. P6-004/005/006 remain IN PROGRESS and P6-GATE remains BLOCKED.
Task 11 remains COMPLETE for its bounded historical application/drill.

The approved next AGY assignment is
`docs/handoffs/2026-11-01-antigravity-phase-6-evidence-pack.md`, with its linked
plan. It starts after PR #3 merges and does not require P6-GATE first. Codex
retains trackers, action/incident records, the gate decision and final Task 16
server handoff. The older actor-loss incident and uncertain scopes remain open
and preserved. No SSH, server mutation, live model/provider, Meta, tunnel or
production action ran during this review; Docker testing was local Desktop
and disposable GitHub Actions only.
