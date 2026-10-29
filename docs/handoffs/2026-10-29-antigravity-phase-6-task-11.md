# Antigravity prompt: Phase 6 local correction and integration evidence

Copy the following instructions into Antigravity. This is a bounded local
development assignment while Codex investigates the preserved synthetic-server
failure and prepares subsequent server evidence. The current server drill is
blocked; Codex will review your correction before planning another fresh scope.
Do not run SSH, deployments, public checks or live services from this assignment.

---

Continue the repository `J:\DevDrive\fcd-support`. Keep communication concise
and maintain full technical rigor. Resume the approved plan; do not restart
project analysis or redesign completed modules.

Codex is actively using the primary checkout and the local test server. Work
in a separate Git worktree/checkout on a review branch, based on freshly fetched
`origin/main`. Do not nest it inside the primary checkout, overwrite an existing
directory, alter primary `main`, merge changes or perform any server action.
Use branch prefix `codex/`, for example `codex/agy-p6-local-closeout`.

## Work allocation and delivery order

You own the following four local tasks on your review branch. Complete them in
this order, using separate commits for independently reviewable changes. Codex
owns server diagnosis, server action records, later deployment and final gate
decisions. Do not edit `docs/TODO.md`, `docs/PROJECT_CONTEXT.md`,
`docs/operations/phase-6-server-deployment.md` or `docs/operations/actions/`;
these are Codex's active files. Read them for current context.

1. **Promotion metadata stability:** implement the existing bounded correction
   specification and plan, with deterministic RED/GREEN regressions and the
   scoped real-Docker projection check. This is the first priority.
2. **Task 11 interruption coverage:** produce the exact gap matrix below and
   address demonstrated missing local regressions within the existing contract.
   Never add a recovery authority or reopen a preserved server scope.
3. **Tasks 12–14 integration readiness:** produce
   `docs/testing/phase-6-tasks-12-14-integration-readiness.md`, linking each
   required interface and local integration behavior to exact existing test
   names and evidence. Add meaningful missing regressions and minimal fixes
   within the already approved timer, health/dashboard and notification designs.
   Keep server-only evidence explicitly pending. This is a bounded integration
   check, not the Task 15 whole-phase review or a phase-completion decision.
4. **Validation and review handoff:** run the relevant local gates, commit and
   push the review branch, and write the results artifact described below. If
   useful, open one draft PR covering these completed tasks. Do not merge it.

For Task 3, check timer revision/lock/catch-up semantics, maintenance binding,
database-outage health journaling, disabled-service status, private operations
route authorization and socket isolation, and signed notification retry/dedup
with erasure and authoritative-state preservation. Reuse existing tests instead
of adding assertions solely to increase test counts. Use local fakes and the
repository's isolated native/PostgreSQL lanes; never install systemd units,
contact n8n or Manifest, or perform inference. Do not redesign interfaces or
change limits, cadence, lifecycle policy or exposure.

Finish with `docs/handoffs/2026-10-29-antigravity-phase-6-results.md` containing:

- [ ] Full fetched base SHA, branch name, resulting commit SHAs and draft PR link
      if created; list every changed file and its task.
- [ ] RED command and decisive failure for each actual fix, followed by GREEN
      evidence. A pre-existing passing test is cited coverage, not a RED result.
- [ ] Exact final commands, exit outcomes, test counts, skips/platform limits and
      real-Docker resource cleanup evidence. Distinguish historical evidence.
- [ ] Completed and incomplete acceptance checkboxes for each of the four tasks;
      exact unresolved behavior, authority boundary and next required proof.
- [ ] Confirmation that no server/live-service action, primary-checkout/main
      mutation, merge, journal settlement or phase/gate completion occurred.

If a later task is blocked, finish earlier independent tasks and deliver their
reviewable commits with the blocker documented. Do not keep the priority fix
uncommitted while attempting a broader redesign.

## Current verified state

- Phase 6 Tasks 1–10 are complete. Task 11/P6-004 is in progress. Tasks 12–14
  have implemented components awaiting final integration/gate evidence. The
  Task 15 whole-phase review and P6-GATE remain open. Do not mark them complete.
- Source `6faff8b37c6bd6d867c2cace30bdb0bc88578561` passed all four GitHub
  workflows: CI `40841770778`, PostgreSQL/native `40841770849`, CodeQL
  `40841770958` and private runtime `40841771071`.
- Its local code gate passed 1,851 tests with 433 platform skips across 125
  files. The native lane passed 1,258 tests across 55 files and 139 PostgreSQL
  tests with one restore-only skip across 13 files. All 41 new subnet cases and
  the real Docker subnet/ownership checks passed.
- The recorded `9c2e404` action deployed that exact source in the fresh private
  synthetic scope `fcd-support-host-test-p6-6faff8b`. Deployment, verification,
  private HTTP/socket checks and prior-state preservation passed. Independent
  verification found four healthy private actors and READY/no job.
- The `cda55ed` action completed real synthetic backup/replay: three signed
  archives and identical authenticated replay metadata. Full preservation
  audits and independent evidence/readiness checks passed. The fresh restore
  target was absent at that checkpoint.
- Latest server result: the `80ea3d2` fresh isolated restore completed, then
  promotion refused. The fresh `6faff8b` selection/job are now uncertain with
  writes possible. Both PostgreSQL actors are healthy; the original-volume
  pointer, completed restore record and override remain; the recorded job actor
  is absent. Rollback was not attempted. Do not retry, clear or resolve this scope.
- A separate read-only actual-Docker probe found a concrete local fix to make:
  `operations_promotion_host_snapshot` compares repeated container projections
  as raw strings. The target projection changed four times across ten reads,
  entirely due to ordering of its two mounts. Every complete observation was
  identical after sorting mount records. This independently demonstrates false
  refusal; the removed job's exact failure point remains unknown.
- Codex may advance the server drill after this prompt was written. Read the
  latest tracker/context instead of assuming a server stage from this snapshot.
- Older `b0ba255` promotion and `8ccb9a0` restore jobs remain uncertain. Their
  original restore targets are stopped with automatic restart disabled; their
  image/reference/volume bindings match the original protected intents. Both
  sources remain healthy. Never restart, clear, replay, adopt or resolve them.
- The original admission snapshot has start-time drift after a newer reported
  host boot; actor IDs, versions, private/read-only properties and original PG
  volume still match. Wall-clock evidence is inconsistent by about a minute.
  A separate current baseline preserves the old snapshot. None of this proves
  SQL-job termination or settles uncertainty.

## Your scope and checklist

- [ ] Read the current repository instructions, `docs/PLAN.md`, `docs/TODO.md`,
  `docs/PROJECT_CONTEXT.md`, `docs/SYNTHETIC_FIXTURE_POLICY.md`, Task 11 and
  Tasks 12–15 of `docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md`,
  `docs/operations/runtime-deployment-safety.md`, and the latest entries in
  `docs/operations/phase-6-server-deployment.md`.
- [ ] Read and implement the bounded correction in
  `docs/superpowers/specs/2026-10-29-phase-6-promotion-metadata-stability.md`
  and its matching plan. This is your priority before the broader gap matrix.
  Add deterministic RED mount-order permutations within and between samples;
  retain every fresh source/target observation through the strict compiled
  TypeScript validator. An equivalent existing trusted canonicalization port is
  acceptable. Do not remove terminal rechecks, ignore failures or sort all arrays
  globally. Commands/entrypoints remain ordered.
- [ ] Require equivalent reordered mounts to pass, while changed source,
  destination, type/name, write mode, propagation, extra/missing entries and
  duplicates still refuse. Use controlled permutations for deterministic CI and
  an actual scoped local-Docker projection test. Do not require Docker's random
  ordering to vary for the test to pass. Add no new host privilege or resolver.
- [ ] Verify branch/base/worktree status. Preserve unrelated work. Recent
  routine pushes used `redwan-cse`; verify the authenticated account before
  GitHub writes and follow the user's current account instructions. Do not
  use owner credentials or bypass protections.
- [ ] Create `docs/testing/phase-6-task-11-gap-matrix.md`. Map each remaining
  Task 11 interruption/recovery requirement to an exact existing test file and
  test name, its evidence type, and any demonstrated missing proof. Include
  intent/create/start/acknowledgement/remove boundaries; missing job actors;
  exact operation-reference/physical-cluster backend settlement; pending state
  replacements and missing pointers; write-aware rollback refusal; and stale
  or replaced admin sockets. Reuse existing evidence and avoid duplicate tests.
- [ ] Select a genuinely missing local regression within the existing approved
  fail-closed contract. Add it test-first, observe RED, and implement only a
  minimal demonstrated fix if needed. Prefer existing focused suites and native
  fixtures. Assert preserved journals/storage, no unintended Docker/SQL action,
  no blind replay or old-volume fallback, and closed diagnostics.
- [ ] Cover at least the supported refusal for an uncertain job whose actor is
  absent, and the separation between backend-settlement observations and
  authority to resolve an operation. If existing tests already cover these
  completely, cite that evidence instead of manufacturing redundant tests.
- [ ] Do not introduce a new resolver, clear `.next`/job records, infer job
  outcome from a missing actor, treat task deletion as an exit receipt, or grant
  runtime readiness from point-in-time SQL checks. A new authority boundary
  requires a separate reviewed design; report that gap without implementing it.
- [ ] Run affected tests, strict TypeScript/lint/format checks, and the relevant
  native Linux lane. Use `VITEST_MAX_WORKERS=4` for the complete Windows gate;
  an unbounded run previously caused five test timeouts. Keep Docker/PostgreSQL
  lanes sequential. Remove only verified resources owned by your synthetic
  tests; never prune globally or delete unknown volumes.
- [ ] Complete the Tasks 12–14 integration-readiness artifact and the results
  artifact with the requirements above. Update only your assigned local source,
  tests, matrices and directly relevant test evidence on the review branch. Do
  not mark tracker phases/gates complete or conduct the whole-phase Task 15
  review prematurely. Codex owns current server evidence.
- [ ] Commit finished, validated branch work and push the review branch. You
  may open a draft PR for review, but do not merge or push to `main`. Report the
  exact base, commit/PR, test counts/skips, native evidence, findings and remaining
  gaps in your final answer. Do not message another chat or service.

## Acceptance criteria

- [ ] The promotion metadata-stability regression reproduces the existing raw
  comparison failure, then passes with the intended semantic comparison. All
  actual observations and negative capability/identity cases remain enforced;
  no changed/extra/missing/duplicate mount is hidden by normalization.
- [ ] Every listed Task 11 requirement is either linked to concrete existing
  coverage or explicitly marked incomplete with a reason and next proof needed.
- [ ] Every checked Tasks 12–14 interface and integration behavior has exact
  local coverage or an explicit gap. Pending server proof stays pending, and
  disabled services are not described as healthy or externally verified.
- [ ] Added regressions exercise a real missing behavior, demonstrate the prior
  failure, and pass with the smallest permitted fix. Tests do not merely mirror
  implementation or weaken deadlines/assertions to obtain a pass.
- [ ] Missing actors, uncertain writes, stale/pending metadata and incomplete
  settlement remain closed. No test or fix silently selects a database, clears
  uncertainty, requeues an unknown delivery or switches back after writes.
- [ ] All fixtures are newly authored synthetic material. No real server values,
  customer data, credentials, OTPs, payment material, raw messages or secret
  values enter tests, output, logs, commits or the PR.
- [ ] PostgreSQL remains authoritative. Models receive no tools. Manifest,
  n8n, OpenClaw and Hermes do not gain authority or public-path access. Keep
  limits configurable; do not change retention, consent, public exposure or
  production-number behavior.
- [ ] No SSH/server, Meta, Manifest, n8n, provider, tunnel or production action
  occurs. No primary-checkout/main mutation occurs. Work is isolated and
  reviewable while Codex owns the separate server investigation and later drill.
- [ ] Final claims match actual executed checks, with exact counts and explicit
  limitations. Local passing checks do not become a P6/P7 or production pass.

If a requirement is blocked by an unapproved recovery design, complete the
unaffected local matrix/tests and report that boundary precisely. Do not invent
a cleanup or recovery shortcut.
