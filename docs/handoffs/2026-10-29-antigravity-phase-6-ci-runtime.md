# Antigravity handoff: Phase 6 CI recovery flow and observer runtime tests

Execute this bounded local test-infrastructure batch while Codex owns the fresh
synthetic-server action. Do not restart project analysis, touch the primary
checkout, run SSH, deploy anything, contact live services or merge a branch.

## Starting point and ownership

PR #1 was reviewed, corrected and squash-merged as
`70f8e7073d20bce0b54d84011e001a2bd5bb527f`. All four merged-source workflows
passed. The tested tree passed 1,873 unit tests with 433 platform skips, 1,280
native tests, and 139 PostgreSQL tests with one separate restore-only skip.
These are overlapping lanes; do not add their counts into a distinct-test total.

The first AGY handoff had seven important issues: an unordered host-bind
comparison regression, a counter lost inside Bash command substitutions, a
copied test canonicalizer, unsupported RED/server-cause claims, incorrect full
SHAs and test citations, invented external gate requirements, and unnecessary
operator personal data. Codex corrected them. Do not repeat those evidence errors.

Use a new separate worktree, for example
`J:\DevDrive\fcd-support-agy-runtime-tests`, and branch
`codex/agy-p6-ci-runtime-tests` from freshly fetched `origin/main`. Record the
full fetched SHA yourself with Git. Require the merged revision above as an
ancestor. Do not overwrite/reuse another checkout or alter primary `main`.

Codex owns `docs/TODO.md`, `docs/PROJECT_CONTEXT.md`,
`docs/operations/phase-6-server-deployment.md`, and all concrete server-action
drivers. Codex is currently fixing signal cleanup in the new passive observer;
do not duplicate that implementation. Task 1 can start now. Task 2 must wait
until the observer correction and its execution plan are published on main,
then incorporate the latest main without discarding your own branch work.

All `6faff8b` and earlier uncertain scopes remain preserved. Their SQL outcome
and the removed job's failure point are unknown. No resolver, retry, journal
clearing or old-volume fallback is authorized. Read current documents instead
of assuming this snapshot remains the latest server stage.

## Read only the relevant context first

- [ ] Read AGENTS.md, docs/PLAN.md, the current tracker/context and
      docs/SYNTHETIC_FIXTURE_POLICY.md.
- [ ] Read Task 11 and the relevant Task 15 requirements in
      docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md,
      the reviewed metadata-stability specification/plan, and the two corrected
      Phase 6 test matrices.
- [ ] Inspect the existing ephemeral CI runtime modes and workflows, public
      operation entry points and synthetic fixture helpers. Reuse their trust
      boundaries. Do not conduct the Task 15 whole-phase review prematurely.

## Task 1: Automate the public synthetic recovery success path in CI

- [ ] Extend the existing ephemeral Linux CI harness to exercise real public
      backup/verification, fresh checkpoint, isolated restore, promotion,
      verification and compatible retained-revision rollback on synthetic data.
      Keep the ordinary server modes unchanged unless a demonstrated shared bug
      requires a separately explained minimal correction.
- [ ] Use a fresh exact-revision project, isolated networks/volumes and the
      existing pinned images. No host ports, external execution, real credentials,
      customer data, Meta, tunnel, Manifest or n8n traffic.
- [ ] Assert authoritative protected state and actual physical identities:
      READY/no job before work, verified signed backup, completed isolated restore,
      fresh promotion onto a distinct target identity, both volumes preserved, and
      compatible rollback retaining the selected restored identity. A marker,
      missing actor, exit code or log line alone is never authority.
- [ ] Test orchestration guards before implementation. A genuinely missing
      failure must be observed RED, then GREEN with the smallest fix. A new passing
      coverage case is coverage only; never fabricate a prior failure.
- [ ] Use the actual production validators/controllers. Do not copy algorithms
      into a test oracle, bypass proof ports, omit fresh observations or globally
      sort ordered execution arrays. If a counter crosses subprocess boundaries,
      explicitly assert that the observations really differ.
- [ ] Keep Docker/PostgreSQL lanes sequential. Cleanup may remove only exact
      verified resources created by the ephemeral test harness. Never prune
      globally, delete unknown/anonymous storage, adopt old scopes, replay unknown
      delivery, infer SQL settlement or introduce a runtime test bypass.
- [ ] Wire the bounded proof into the appropriate existing GitHub workflow and
      run it locally where supported. Distinguish actual Linux/CI execution from
      Windows skips or static assertions. Keep workflow runtime/resource bounds.

Acceptance: a fresh runner can execute the complete public recovery success
path without cached local artifacts or live services; a failed/missing proof
cannot advance later stages; diagnostics contain only allowed closed metadata;
owned resource cleanup is independently verified.

## Task 2: Expand hermetic observer runtime verification after Codex publishes it

- [ ] Wait for the published observer and
      docs/superpowers/plans/2026-10-29-phase-6-observed-fresh-drill.md. Read Codex's
      signal-cleanup fix first. Your task is additional genuine coverage, not a
      competing implementation of that fix.
- [ ] Exercise the actual observer loop through synthetic subprocess/stream
      fixtures: full protocol/lifecycle, fragmented UTF-8 and CRLF, startup failure,
      EOF, bounded timeouts, partial launch, interruption, process reaping and guard
      refusal. Cite existing cases if complete; avoid duplicate tests.
- [ ] Prove no log following starts before matching protected job metadata,
      stable journal identity and actual immutable actor identity. Test foreign
      events, substituted image/reference/project/command, missing actor, replaced
      journal, malformed frames, duplicate challenges and boolean numeric fields.
- [ ] Verify raw stdout/stderr, unknown labels, references, IDs, challenges,
      arbitrary exception text and synthetic sensitive sentinels never enter
      persisted/output records. Test limits on buffers, record count and duration.
- [ ] Do not add a production test switch, arbitrary output path, remote Docker
      endpoint, SQL capability or mutating Docker command. Test-only mocks may live
      in test processes; runtime guards must remain mandatory. Only the observer's
      own reader processes may be terminated.
- [ ] If a new defect is demonstrated, fix it minimally on your review branch
      with RED/GREEN evidence. Allowed observer-file exceptions to Codex ownership
      are the observer helper and its test file only, after Codex's fix is published.
      Do not edit concrete deployment/backup/preparation/restore-stage drivers.

Acceptance: runtime tests exercise real control flow rather than helper copies;
readers are bounded/reaped; failure remains diagnostic and grants no operation
resolution, SQL-outcome inference, readiness or state mutation.

## Task 3: Exact validation and reviewable delivery

- [ ] Run focused tests, lint/typecheck/build and affected shell/Python syntax
      checks. Use VITEST_MAX_WORKERS=4 for the complete Windows check. Run relevant
      native/PostgreSQL and actual Docker lanes sequentially, once required by the
      change; do not broaden/repeat successful tests without a new reason.
- [ ] Audit every named test citation against the actual file/title. Copy full
      SHAs from Git output, not manual guesses. Keep historical and newly executed
      evidence separate. No passing claim for an unrun native/live lane.
- [ ] Write docs/handoffs/2026-10-29-antigravity-phase-6-ci-runtime-results.md
      with task checkboxes, exact base/commit SHAs, changed-file ownership, RED/GREEN
      commands and decisive outcomes, final test counts/skips, CI links, cleanup,
      unresolved gaps and boundary confirmations. Record no operator email or
      personal data. Do not mark Task 11, Task 15 or P6-GATE complete.
- [ ] Commit validated work in reviewable steps and push the review branch.
      Verify the intended authenticated routine GitHub account before writes;
      recent approved routine work used redwan-cse. No owner credentials or
      protection bypass. Open a draft PR for Codex review; do not merge/push main,
      contact another chat or send messages to other people/services.

If an authority boundary blocks a task, finish the independent permitted work
and report the exact missing proof. Installing host systemd units, reboot
trials or enabling optional live n8n/Manifest services is not an invented Phase
6 prerequisite. Production and old uncertain scopes remain untouched.
