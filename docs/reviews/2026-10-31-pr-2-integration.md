# PR #2 integration and fresh server action

Date: 2026-10-31 (Asia/Dhaka).
Decision: PR #2 merged; Task 11 and P6-GATE remain open pending server proof.

## Reviewed source and correction

AGY delivered `e867edcf1b1dad691b65d72279daf9f19e2771b9`. Fresh independent
review identified raw failed-job log forwarding, diagnostic codes derived from
arbitrary schema-map keys, and unbounded repeated diagnostic reporting. Codex
reproduced these failures and corrected them at
`9c6ffc59c56222bba2909f132bf28ef2194bc844`. Raw job logs are no longer forwarded;
diagnostics use finite literal codes and bounded, deduplicated reporting. Full
mount attributes and multiplicity, ordered execution arrays, current identity,
source freezing and interactive challenges remain enforced.

[PR #2](https://github.com/thefastcyberdefense/fcd-support/pull/2) was squash-merged
as `67a4a4bede6d3252dc936a6e410f4b90c1359ac3`. The application, infrastructure,
scripts, tests and package files match the tested correction exactly.
The earlier HOLD review remains historical evidence, superseded by this record.

## Independently verified evidence

Counts overlap and must not be added into a distinct-test total.

- Corrected Windows `VITEST_MAX_WORKERS=4 npm run check`: exit 0;
  1,922 passed / 433 platform skips; 128 files (114 passed / 14 skipped);
  259.61 s. Phase 0, formatting, lint, strict typecheck and build passed.
- Focused diagnostic/controller regressions: 138 passed across six files.
  The reported leaks and repeated-output case failed before correction.
- Actual Docker projections: six passed; stopped-job creation was Linux-only
  and skipped on Windows. Observer hermetic tests: 32 passed / one Windows
  SIGHUP skip. These are not actual server promotion observations.
- Exact corrected-source [CI](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41166555228):
  PASS; 1,985 passed / 370 lane skips; 128 files; 56.02 s.
- Exact corrected-source [PostgreSQL/native](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41166555187):
  PASS; native 1,293 / 55 files / 311.50 s; grants PostgreSQL 139 / one
  restore-only skip / 13 files / 37.93 s; restore units 250 / 12 files /
  38.66 s; two-cluster PostgreSQL 47 / two files / 16.10 s; complete
  PostgreSQL 620 / 52 skips / 56 files / 113.14 s.
- Exact corrected-source [CodeQL](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41166555189):
  PASS. [Private runtime](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41166555197):
  PASS in both fresh and precreated modes. Each mode observed deploy, verify,
  private HTTP, backup, checkpoint, restore, promote, compatible rollback,
  recovery and owned cleanup. Rollback uses the same retained revision and
  preserves the restored physical identity; no older-version switch is claimed.

## Server diagnosis and concrete action

Read-only SSH inspection found the clean server source still at `6faff8b`.
The historical saved-baseline audit refuses changed actor start/network metadata.
Comparisons by network name found only the default bridge identity/creation
changed; custom network identities/configurations and membership matched.
Docker journal initialization coincides with that default-bridge recreation.
Protected files, volumes and actor definitions matched, and two current
observations were stable. No SQL outcome or old job settlement follows.
The `6faff8b` target is stopped with restart disabled and stays stopped.

A separate current baseline will be captured only in the new `67a4a4b` action
scope. All old snapshots, uncertain journals, overrides, databases and volumes
remain preserved. The four new pinned action records and the observer's three
pin substitutions received fresh independent review with no Important/Critical
findings. Read-only `--inspect` passed. Python/shell syntax, observer pure tests
and `git diff --check` passed. Nothing in the new scope has executed yet.

Execution requires all four exact merged-source workflows to pass, followed by
committing/pushing the concrete records. Run each new stage once, with the full
saved-baseline audit between stages. Refusal or uncertainty stops dependent
work; preserve evidence and never retry/clear an old job. The observer is passive,
content-free diagnostics, without SQL/readiness or subscription-ack authority.

## AGY branch and remaining ownership

The squash merge exposed four conflicts in the matrix branch's older runtime
history. Codex resolved those and one auto-merged stale script fragment against
the reviewed main tree, then pushed `ac6e7c07fd7362b947ff0da6575b95be0d79a52c`.
The entire application tree equals main; only the gap-map document differs.
Task 15 implementation remains blocked until Task 11 is recorded complete.
Existing ENOSPC, restore quarantine and fake lock-conflict tests must not be
recreated as new coverage. Narrow genuinely missing assertions in the next AGY
handoff. Codex retains server execution, trackers and independent gate review.

## Merged-source execution gate

All four workflows for exact `67a4a4b` passed before committing the action:
[CI](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41167434851),
[CodeQL](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41167434819),
[PostgreSQL/native](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41167435035)
and [private runtime](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41167434856).
The next AGY checklist and acceptance criteria are recorded in
`docs/handoffs/2026-10-31-antigravity-phase-6-next.md` and its linked focused plan.
