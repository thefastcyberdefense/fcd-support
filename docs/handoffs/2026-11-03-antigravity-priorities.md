# AGY next assignments: dashboard, health transport, Phase 7 readiness

Date: 2026-11-03 (Asia/Dhaka).
Authority: repository fixes/tests and preparation only. Codex owns acceptance,
merge, current-server recovery/disposition and deployment. Production WhatsApp
and the connected Meta test webhook stack remain unchanged.

## Start and delivery rules

- [ ] Read AGENTS.md, PLAN/TODO/PROJECT_CONTEXT, the synthetic fixture policy,
      current incidents and linked assignments before changing code.
- [ ] Fetch fresh synchronized main. Use separate isolated branches/worktrees;
      preserve the primary checkout and other agents' work. Record exact base/head.
- [ ] Start Priority 0 first. Submit each package as its own draft PR with a
      checklist, RED/GREEN evidence for code changes, exact checks and unresolved
      limitations. Do not merge or claim phase/gate approval.
- [ ] Use only newly authored synthetic fixtures. Never inspect/copy credentials,
      customer data, private server records, screenshots containing identity or
      session details, unrestricted logs or external payloads.
- [ ] No SSH/shared-server Docker, provider/model/Manifest/n8n/Meta calls, public
      DNS/tunnel changes, host restart, account reset or production actions.

## Priority 0: fix the three dashboard HTTP 500s

Branch: `codex/agy-admin-dashboard-permissions`.
Evidence: `../testing/2026-11-03-admin-dashboard-permissions.md`.

Codex reproduced all three compiled list methods under the actual deployed
restricted admin login in read-only mode: SQLSTATE 42501. Configured grants
lack dependencies of the live privacy-eligibility joins and escalation counts.
No server permission was changed.

- [ ] Write failing PostgreSQL regressions using `configureRuntimeGrants` and
      the actual nonsuperuser admin login, not the fixture owner connection.
      Exercise `PostgresAdminDashboard.listQuestions`, `listInsights` and
      `listEscalationCounts`. Record RED before changing production source.
- [ ] Add authenticated HTTP integration coverage using the real identity,
      real PostgreSQL dashboard and `buildAdminApp`; prove password/MFA, all
      three GET routes and appropriate RBAC. Unit mocks alone are insufficient.
- [ ] Make the smallest grant correction, starting from the dependency table in
      Codex's evidence document. Prefer exact column-scoped SELECT permissions.
      Preserve privacy/retention eligibility and distinct-person thresholds.
      Do not grant whole identity/event/privacy tables to make a query pass,
      replace runtime credentials with an owner role or mask errors as empty data.
- [ ] Prove HTTP 200 for empty states and eligible populated states, correct
      aggregates and no customer content in HTML/errors/logs. Retest a later
      privacy hold, insufficient groups and expired observations using the
      restricted role: questions/insights must suppress ineligible data rather
      than returning stale stored aggregates. Preserve review requirements.
- [ ] Add negative privilege controls: admin still cannot read webhook message
      text or raw receipt metadata, mutate source messages/identities/privacy
      state or escalation outcomes, or perform DDL. Authentication, MFA, session
      revocation, CSRF and denied roles must retain their behavior.
- [ ] Include an authenticated GET smoke matrix for existing sidebar modules:
      knowledge, questions, insights, policy, escalations, audit and operations,
      with expected authorized/unauthorized outcomes. Reuse existing test
      infrastructure. This is a regression fix, not a UI redesign.
- [ ] Run appropriate local/full code checks and real Linux/PostgreSQL tests.
      Existing CI must pass on the final exact head. Report lanes separately;
      do not sum overlapping counts or label skipped cases as passing.
- [ ] Record results in
      `2026-11-03-antigravity-admin-dashboard-permissions-results.md`, commit/push
      and open a draft PR. Report additional missing permissions with a failing
      owning-boundary test instead of broadening privileges.

Acceptance: the original three failures are RED before the fix and GREEN under
real runtime grants afterward; authenticated HTTP returns 200 when authorized;
empty/populated states, privacy suppression, RBAC and negative privilege checks
pass; diagnostics remain secret-safe; final source checks are green. No live
rollout is included. Codex handles deployment after review and safe disposition
of the current health uncertainty.

## Priority 1: recurring health transport/acknowledgement regression

Follow `2026-11-03-antigravity-health-transport-stress.md` in its own branch.
PR #8 is merged; start from current main. Later server inventory confirms another
uncertain health job with its actor absent; scheduled backup/maintenance/health
now refuse. The app remains available.

- [ ] Execute the existing bounded compiled-transport stress assignment for
      fresh and precreated disposable runner layouts.
- [ ] Stop on uncertainty. Never clear/replay it, infer SQL commit from actor
      absence, add a recovery resolver or relax acknowledgement acceptance.
- [ ] Supply a failing reproduction for any application bug and exact closed
      outcome classes. Codex retains runtime correction and server deployment.

Acceptance and results filename are defined in the linked assignment. This is
independent of Priority 0; keep PRs separately reviewable and do not mix grants
fixes with transport changes.

## Priority 2: prepare existing Phase 7 acceptance work

Follow `2026-11-02-antigravity-phase-7-readiness.md`, docs only, on its own branch.

- [ ] Map existing P7-005/acceptance items to current local/native/CI proof,
      historical external proof, missing current live/manual proof, dependencies,
      owner and operational approval boundary. Do not invent P7 task IDs.
- [ ] Treat old P7-001 through P7-004 completions as historical test-asset
      evidence, not proof that the current private runtime is connected.
- [ ] Make dashboard permission correction and recurring-health disposition
      explicit readiness dependencies. Preserve the connected webhook stack.
- [ ] Identify procedures still needed for Manifest recording-off, dedicated
      fcd-support/model auto, approved configurable limits/fallback, network
      isolation, real Meta test delivery, manual echoes/takeover, bilingual
      quality, consent/deletion, restore and outage/restart evidence.
- [ ] Keep production readiness and production-number work outside this package.
      No live integration or full-host restart is delegated.

Acceptance: a source-backed readiness matrix with valid references and the
smallest executable next package for Codex/operator review. Force Markdown
formatting, validate Phase 0, check relative links/citations and secret patterns,
then commit/push a separate draft PR. Live/manual items remain pending.
