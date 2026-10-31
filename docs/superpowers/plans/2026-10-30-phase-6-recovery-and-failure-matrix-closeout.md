# Phase 6 recovery and failure-matrix closeout implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task.
> Steps use checkboxes. The owner selected AGY execution and delegated routine
> implementation decisions; no repeated per-detail approval is required.

**Goal:** Complete the actual public synthetic recovery proof, then close only
verified gaps in the already approved Phase 6 failure matrix.

**Architecture:** Retain PostgreSQL authority and the existing public controllers,
protected journals, physical identity checks and two fresh promotion exchanges.
AGY owns bounded local/CI corrections and tests; Codex owns integration, server
execution and the independent whole-phase review. No new runtime authority.

**Tech stack:** Existing strict TypeScript/Vitest, Bash, Python standard library,
pinned Docker images and existing GitHub Actions workflows. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-6-hardened-local-operations-design.md`,
with the accepted post-verification metadata-stability specification. This plan
continues Tasks 11 and 15 of the approved 2026-10-04 implementation plan; it does
not authorize a new product phase or external-service connection.

## Global constraints

- Preserve production assets and every `6faff8b` or earlier uncertain scope.
- AGY performs no SSH, server deployment, tunnel/DNS/Meta/Manifest/n8n mutation,
  live provider call, production action, main push or merge.
- Models receive no tools. PostgreSQL remains authoritative. Fixtures and
  evidence follow `docs/SYNTHETIC_FIXTURE_POLICY.md`.
- Never infer SQL outcome from actor absence, exit codes, backend closure or
  diagnostic markers. Never clear a journal, retry an uncertain scope, skip a
  proof, restore an old writable volume or introduce a resolver/test bypass.
- Keep all configured limits and privacy/role isolation guards mandatory. Do
  not increase a limit merely to obtain green. A measured fixture configuration
  correction needs explicit evidence and regression coverage, with runtime
  defaults unchanged. The existing CI-only checkpoint profile is already 600,000 ms.
- No raw logs, identities, references, challenges, credentials or arbitrary
  exception text in evidence. Closed stage codes/counts/durations/revisions only.
- Root-owned files are `docs/TODO.md`, `docs/PROJECT_CONTEXT.md`,
  `docs/operations/phase-6-server-deployment.md`, `docs/operations/actions/**`,
  acceptance/threat/gate decisions and concrete deployment drivers. Read them;
  do not edit them in this assignment.
- Use existing isolated test projects. Verify exact ownership and sole users
  before cleanup. No global prune, unknown storage deletion or Docker-daemon
  configuration change. Keep native/Docker/PostgreSQL lanes sequential.

## Review focus

1. A closed diagnostic lost through stderr redirection must still reach CI;
   arbitrary stderr must remain private (Task 1).
2. Normal later validation noise must not hide the failed promotion exchange
   leg; retain bounded trusted frames without logging protocol values (Task 1).
3. A failed/missing proof must stop the next stage even inside functions,
   substitutions and subshells; preserve strict child guards (Task 1).
4. Duplicate/foreign actors, replaced resources and failed inventory reads must
   refuse cleanup rather than prove absence (Task 1).
5. A fake outage must exercise real application behavior; fixed zero-valued
   reports or disabled clients alone cannot establish recovery safety (Task 3).

## Task 1: Finish the public recovery proof on PR #2

**Files to inspect:** `scripts/operations-job-lifecycle.sh`,
`scripts/operations-promotion-host.sh`, `scripts/operations-promotion-controller.sh`,
`src/operations/promotion-main.ts`, `src/operations/promotion-host.ts`,
`scripts/test-synthetic-runtime-deployment.sh`, `scripts/synthetic-host-evidence.sh`.
Modify only the demonstrated owning module and its tests. Current test anchors:
`tests/promotion-host-transport.test.ts`, `tests/promotion-host-script.test.ts`,
`tests/operations-job-lifecycle.test.ts`, `tests/operations-promotion-controller.test.ts`,
`tests/synthetic-host-evidence.test.ts`, `tests/synthetic-recovery.test.ts`,
`tests/synthetic-cleanup.test.ts`.

**Consumes:** Frozen review head `c185c7d572b0b2ab6c91fa94a7c9f83dc630717b`,
the independent PR review, and the failing private-runtime run linked there.
`operations_job_promotion_exchange()` returns success only after two fresh
exchanges and the exact final ACK; `operations_promotion_host_check()` and
`operations_inspect_promotion_host()` remain the actual proof ports.
**Produces:** A corrected immutable PR #2 checkpoint and all four passing
exact-source workflows, including the complete public path in both network modes.

- [ ] Fetch `origin/main` and `origin/codex/agy-p6-ci-runtime-tests`. Use the
      existing isolated worktree `J:\DevDrive\fcd-support-agy-runtime-tests` on
      that review branch. Require a clean tree, verify the full fetched SHA and
      require `c185c7d` as ancestor. Fast-forward only; preserve unexpected work.
      Do not check out or modify primary `main`.
- [ ] Read the new handoff/plan/review from `origin/main` with `git show` if they
      are absent from the review branch. Read AGENTS, PLAN, current TODO/context,
      fixture policy and the accepted Task 11 specifications. Read tracking and
      context from fresh `origin/main` even if older copies exist in the branch.
      Do not restart
      a repository-wide analysis.
- [ ] Reproduce the failed fresh/precreated public workflow from a fresh real
      disposable GitHub runner. Restore completes; the promotion job/selection
      become uncertain before the later actor-retirement guard. Do not replay
      anything on the persistent server or spoof CI admission on that server.
- [ ] If needed, add a behavioral diagnostic regression in
      `tests/synthetic-host-evidence.test.ts`: a trusted transport failure frame
      followed by more than 64 normal common/state frames must still be reported;
      arbitrary file names, references, challenges and sensitive sentinels must
      remain absent. Run the test RED, then minimally prioritize the closed
      transport evidence in `scripts/synthetic-host-evidence.sh`. Keep bounds.
- [ ] Locate whether failure is challenge read/framing, exact host refusal,
      host-check deadline, reply write, final ACK, process settlement or a job
      error. Record actual evidence; a plausible timeout is not a confirmed cause.
      Measure critical-path tracing overhead as well: the current CI wrapper
      enables granular DEBUG tracing during promotion, whose host exchanges are
      time-bounded. A fresh controlled run with coarse closed stage evidence
      may test that hypothesis while retaining every actual proof. Never reuse
      a failed scope or claim tracing caused historical failures.
      Obtain any additional stage evidence before owned actor cleanup, using
      only exact scope/identity bindings and closed metadata. Do not copy the
      production validator into a test oracle or add a runtime escape hatch.
- [ ] Add the smallest failing regression through the actual owning interface.
      For example, a fresh pair of valid challenges must produce two proof calls
      and one final ACK; a failed proof, stale reference, repeated nonce, missing
      response or unexpected EOF must refuse without later SQL/host advancement.
      Reuse real transport/control flow and fake only external process ports.
      A case already passing is coverage, not fabricated RED evidence.
- [ ] Apply the minimal demonstrated fix. Preserve raw mount fields, multiplicity,
      ordered commands/entrypoints, every fresh observation, source freeze,
      physical identity and write-aware rules. No unrelated refactor or new API.
- [ ] Run affected focused/native tests and actual Docker probes. Verify the
      complete public backup verification, fresh checkpoint, isolated restore,
      promotion, verification, same-revision retained rollback and owned cleanup
      through `scripts/test-synthetic-runtime-deployment.sh` in both existing
      ephemeral CI modes. Actual protected state and physical identities must
      establish each outcome; markers alone do not.
- [ ] Run validation listed in the handoff. Publish the Priority 0 checkpoint
      separately before broader work. Update PR #2, report its full SHA and exact
      workflows, then freeze this branch/worktree for Codex review. Never merge it.

**Acceptance:** Both network modes reach READY/no active job after promotion and
rollback; promotion selects a distinct restored physical identity and preserves
both volumes until reviewed success-only cleanup; rollback retains the restored
identity; exact owned actors/networks/volumes/tags are gone after cleanup and
unrelated inventory is unchanged. All four current-source workflows pass. No
uncertain operation is resolved or replayed to make this happen.

## Task 2: Prepare the remaining matrix without duplicating tests

**Files:** Create `docs/testing/phase-6-failure-matrix-gap-map.md` in a second
isolated worktree `J:\DevDrive\fcd-support-agy-failure-matrix` on branch
`codex/agy-p6-failure-matrix` (verify the directory is absent before creation),
after Task 1's checkpoint
is delivered and frozen. Read the existing Task 11 gap matrix, Tasks 12–14
readiness matrix and original Task 15 requirements.

**Consumes:** The frozen Task 1 source and existing exact test titles/evidence.
**Produces:** An auditable requirement-to-test map, not a phase-gate decision.

- [ ] For each required outage/interruption, name the exact file, test/template
      title and parameters, actual execution lane, latest verified source, and
      any missing assertion. Distinguish present-but-unrun, actual gaps,
      Codex-owned server proof and P7/P8 deferred live evidence.
- [ ] Cover the six component outages, every deployment/promotion boundary,
      timer catch-up, stale-event admission, readonly/full backup destination,
      malformed ciphertext, checkpoint drift, restored accepted outbox work,
      revoked admin sessions, stale health, simultaneous lock and stale/replaced
      socket behavior. Reuse existing coverage; no artificial new-test quota.
- [ ] Audit citations against current files. Do not invent successful test runs,
      source SHAs, live n8n/systemd/reboot requirements or a required automatic
      resolver. Actor-absent uncertainty correctly fails closed.
- [ ] Publish the map in a separate draft PR/worktree. Until Codex records
      Task 11/P6-004 COMPLETE with its server evidence, this branch is limited
      to preparatory inventory/documentation. Do not implement Task 15 early.

**Acceptance:** Every original Task 15 requirement has a verifiable existing
proof or a precise missing assertion and owning file. No duplicate of the
already reviewed 84-title matrices is presented as new execution evidence.

## Task 3: Implement only confirmed Task 15 gaps after dependencies clear

**Entry condition:** Codex has integrated Task 1, recorded Task 11 COMPLETE and
cleared the original tracker dependencies. Fetch and merge current `origin/main`
into the matrix branch; do not rewrite history or discard changes. Codex retains
all server and gate work. The owner's existing implementation approval applies.

**Files:** Prefer existing owning tests: `tests/model-reply-service.test.ts`,
`tests/outbound-worker.test.ts`, `tests/notification-worker.test.ts`,
`tests/health-collector.test.ts`, `tests/operations-health-host.test.ts`,
`tests/systemd-contract.test.ts`, and the matching PostgreSQL integration files.
Network/Compose evidence uses `tests/helpers/phase6-network-fixture.ts` and
`scripts/test-phase6-local.sh`. Create
`tests/integration/phase6-failure-recovery.test.ts` only when a genuinely missing
cross-component database scenario cannot be proved in an existing owning test.

**Consumes:** Accepted source, Task 2's confirmed gaps and real application APIs.
**Produces:** Runnable missing assertions with minimal owning-module repairs;
existing runbooks may be extended in `docs/operations/hardened-runtime.md`,
`docs/operations/backup-and-restore.md` and
`docs/testing/phase-6-operations-evidence.md`.

- [ ] Select one confirmed missing assertion, name its actual public/worker
      interface, and write the failure case before changing production behavior.
      Tests derive writes/sends/incident state from actual PostgreSQL or captured
      injected clients, never fixed zero-valued summary objects.
- [ ] For relevant outage cases, assert no leaked sensitive sentinel, no extra
      network path, no blind resend and the documented PostgreSQL state. Require
      a successful control using the same fake so disabled/no-op paths cannot
      falsely establish outage recovery.
- [ ] Use authored fake Manifest/Meta/n8n clients or guarded local fake servers.
      Real deployed stacks retain all three execution flags false. Pure tests
      may enable a feature only against injected/loopback synthetic fakes;
      never contact real provider endpoints or use real credentials.
- [ ] Run RED, make only the minimal demonstrated owning-module fix, run GREEN,
      and commit each independently reviewable gap. If a capability/authority
      change is required, preserve the failing test and report the boundary to
      Codex instead of adding a resolver or weakening a guard.
- [ ] Re-run the original multihomed ordinary-egress ingress proof. Do not
      replace it with an internal-only topology or skip an unfavorable probe.
- [ ] Update only the allowed runbooks with inputs, secret ownership contracts,
      safe drain, revision pins, socket/SSH access, backups, fresh checkpoints,
      recovery holds, rollback limits and unavailable-service behavior. No
      credentials, private identifiers, raw logs or unexecuted live claims.
- [ ] Run the full required local gate once final relevant changes are frozen,
      the sequential guarded PostgreSQL/native/restore lanes and affected real
      Docker/network checks. Verify cleanup independently. Push the separate
      draft PR and exact results for Codex's fresh whole-phase review.

**Acceptance:** Confirmed gaps are closed through real behavior, no existing
proof is weakened, all relevant checks pass and owned cleanup is proven. AGY
must not mark P6-GATE approved, execute Phase 7 live work or self-approve its
implementation. Codex conducts the independent complete-phase review.
