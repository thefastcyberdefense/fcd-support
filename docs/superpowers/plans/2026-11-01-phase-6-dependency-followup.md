# Phase 6 Dependency Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> and the repository's test-first workflow. Use an isolated branch.

**Goal:** Resolve or present a concrete reviewed disposition for the two open
runtime-transitive dependency alerts before freezing the final Phase 6 gate pack.

**Architecture:** Evaluate the supported migration-tool dependency chain and
make the smallest compatible pinned update when justified. Preserve the owning
migration/restore interfaces and all existing private execution boundaries.
Package presence alone does not establish a public exploit path.

**Tech Stack:** Node/npm at the approved versions, strict TypeScript, locked
dependencies, synthetic PostgreSQL/native/Docker tests and GitHub Actions.

**Spec:** Phase 6 dependency pinning and runtime contract in `docs/PLAN.md`;
the approved 2026-10-04 Phase 6 implementation plan; the two findings below.

## Intake and scope

GitHub reported these open medium alerts after the PR #3 merge:

- [#43 / CVE-2026-118764 / GHSA-g3hv-75wg-m249](https://github.com/thefastcyberdefense/fcd-support/security/dependabot/43):
  `minimatch@10.2.6`, potential globparts amplification denial of service;
  reported patched floor `11.0.1`.
- [#42 / CVE-2026-118773 / GHSA-3g3m-2fjr-6pw4](https://github.com/thefastcyberdefense/fcd-support/security/dependabot/42):
  `glob@13.0.6`, AbortSignal cancellation bypass/post-timeout traversal;
  reported patched floor `14.0.2`.

The locked runtime chain is `node-pg-migrate@9.0.0 -> glob@13.0.6 ->
minimatch@10.2.6`. The direct parent currently requires `glob ~13.0.0`, so a
blind major transitive override is not a routine lock refresh.

Codex's static-only triage is **needs_review** for both application-boundary
claims. `runForwardMigrations` fixes the migrations directory and does not
enable `useGlob` or provide an AbortSignal. The inspected upstream file
discovery defaults `useGlob=false`. These are counterevidence to a public
exploit claim, not permission to dismiss the alerts. Complete compatibility
and supported-configuration assessment remains. Root SECURITY.md is a generic
template; do not invent a project policy or unsupported-version exclusion.

## Global constraints

- PR #3 is merged as `df8e52d`; tested source is `7801314`. Read fresh main's
  AGENTS, TODO, PROJECT_CONTEXT, SYNTHETIC_FIXTURE_POLICY and integration review.
- Create `codex/agy-p6-dependency-followup` from synchronized main in the existing
  clean isolated AGY worktree; preserve existing changes and never force-push.
- No SSH, server/daemon/shared-resource mutation, live model/provider/n8n/Meta,
  tunnel, production assets, customer data or credentials. Registry/advisory
  reads and isolated local tests are permitted. Never print registry tokens.
- Do not edit primary trackers/actions/incidents, change supported Node/runtime
  floors, weaken CI audit thresholds, dismiss alerts or approve the phase gate.
- Keep scope to these findings. No broad dependency refresh, new package
  manager, new product feature, recovery-policy change or unbounded PoC load.

## Review focus

- Report installed/locked vulnerable copies separately from exploitability.
- Prefer a supported direct-parent update over an unverified transitive major.
- An override needs exact scope, pinned versions and owning API compatibility.
- Real migration/restore behavior must pass; a version-string test is insufficient.
- Default-branch alerts may remain open until a fix merges and GitHub refreshes.

## Task 1: Revalidate findings and choose a supported correction

**Files:** Read `package.json`, `package-lock.json`,
`src/operations/forward-migration.ts`, migration/restore callers and existing
guarded tests. Use primary upstream advisory/release/registry sources only.

- [ ] Resolve full Git SHAs with Git and verify clean state. Re-read the two
      alerts, vulnerable ranges and current supported patched releases.
- [ ] Trace affected runtime copies and all repository-supported callers;
      distinguish private fixed-directory migration behavior from arbitrary
      patterns or cancellation APIs. Record evidence and remaining proof gaps.
- [ ] Check whether a compatible pinned `node-pg-migrate` update brings patched
      dependencies. Prefer that minimal supported chain when available.
- [ ] If only major transitive updates are available, prepare exact scoped
      override options and upstream compatibility evidence before adopting one.
      Do not use `npm audit fix --force` or silently widen declared support.
      If compatibility cannot be established, return a concrete proposal and
      stop that dependency change for Codex review; do not self-dismiss findings.

## Task 2: Minimal update and owning verification

**Files:** Modify only `package.json`/`package-lock.json` and demonstrated
compatibility regressions in existing migration/restore tests as needed.

- [ ] Capture baseline package/range or bounded behavioral failure honestly.
      Do not fabricate an exploitable public path or claim a version-only
      assertion is a reproduced security exploit.
- [ ] Apply the minimal supported pinned change. Preserve lockfile integrity,
      reproducible clean installation and existing migration/restore APIs.
- [ ] Run meaningful affected tests: real forward migrations on an empty and
      upgraded synthetic database, restricted-principal and physical-target
      refusals, idempotent replay, isolated restore and compatible rollback.
      Keep all real/customer databases and old uncertain scopes untouched.
- [ ] Verify the runtime dependency tree no longer contains the affected
      versions for these advisories, or clearly report the unresolved chain.
      Compare advisory and npm-audit results without hiding severity or data lag.
- [ ] Run final `VITEST_MAX_WORKERS=4 npm run check`, required guarded sequential
      PostgreSQL/native/restore/runtime gates, scoped cleanup, formatting,
      secret-pattern and diff checks. Require all four exact-source workflows.

## Task 3: Delivery and next sequence

**File:** Create `docs/handoffs/2026-11-01-phase-6-dependency-results.md`.

- [ ] Record the two findings separately, source/locked/fixed versions,
      reachability limits, chosen compatibility rationale, full Git-generated
      SHAs, actual commands/counts/skips/durations/links and cleanup. Verify
      quoted Git references with `git cat-file -e '<sha>^{commit}'`.
- [ ] Open a separate draft PR and return it to Codex. No main merge, alert
      dismissal, server redeployment or final gate decision is assigned.
- [ ] After Codex accepts the dependency PR or a documented disposition, continue
      `docs/handoffs/2026-11-01-antigravity-phase-6-evidence-pack.md` on a fresh
      branch from that main. Final evidence must cite the accepted dependency
      source rather than freeze counts before this review.

Self-review: this addresses the concrete dependency follow-up discovered during
integration, while keeping PR #3's accepted testing work and the final evidence
assignment intact. Codex retains final compatibility/disposition, gate and
Task 16 decisions. No new routine owner approval is needed for this scope.
