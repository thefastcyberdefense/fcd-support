# PR #13 Audit & Governance Technical Review

> Submitted AGY review; retained as historical input. Codex's 2026-11-07
> [independent disposition](2026-11-07-agy-update-disposition.md) supersedes its
> blanket verification, merge-deletion and story-approval claims. The endpoint
> comparison does not establish PR deletions, a skipped check is not enforcement
> evidence, and US-101..105 are proposals rather than approved implementation.
> The remainder below preserves the submitted report, not Codex endorsement.

Date: 2026-11-04 (Asia/Dhaka).
Reviewed head: `691f78b0f532c39550a554e8ec62e87c976cc8e7` (`codex/agy-ci-and-repo-governance`).
Comparison base: `origin/main` at `ab6036aff5c5b3211df1655c450780957b5e9f83` (branched from `443d05b94dcffcafa17dea98fe6b6443fb5d8006`).
Decision: **Corrections required; retain draft/unmerged.**

---

## 1. Safety & Authority Boundaries

- **Inspection Environment:** Read-only inspection executed in dedicated worktree `J:\DevDrive\fcd-support-pr-13`. The primary checkout (`J:\DevDrive\fcd-support`) remains on `main` without uncommitted functional code changes.
- **External Interfaces:** Zero SSH, shared-server Docker/systemd, Cloudflare Tunnel, Meta Graph API, Manifest model API, or n8n operations were triggered.
- **Draft Retention:** PR #13 remains in **DRAFT** state.
- **Production Boundary:** The existing production WhatsApp Business account, customer data, and live secrets remain untouched and private.

---

## 2. Review Findings & Gate Summary

PR #13 introduces essential repository governance infrastructure, security policy disclosure, CodeQL action pin, branch protection gate scaffolds, and six audit deliverables. While the governance architecture and audit findings are substantively sound, the pull request cannot be merged in its present state due to static analysis failures, trailing whitespace, branch divergence, and CI gate failures on GitHub Actions.

### Static & CI Gate Verification Matrix

| Check                              | Target / Command                                                                               | Result   | Evidence / Details                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 0 Gate**                   | `npm run validate:phase0`                                                                      | **PASS** | Exit 0. Citations, mappings, and tracker structure valid.                                                                                                                                                            |
| **Prettier Formatting**            | `npx prettier --check . docs/audits/*.md`                                                      | **FAIL** | Exit 1. Style issues in `SECURITY.md` (table alignment) and `scripts/verify-pr-handoff.ts` (multiline `write`).                                                                                                      |
| **ESLint**                         | `npm run lint`                                                                                 | **FAIL** | Exit 1. `scripts/verify-security-policy.ts:36:9` error: `The value assigned to 'content' is not used in subsequent statements (no-useless-assignment)`.                                                              |
| **TypeScript (Typecheck)**         | `npm run typecheck`                                                                            | **PASS** | Exit 0 (`tsc --noEmit`).                                                                                                                                                                                             |
| **TypeScript (Build)**             | `npm run build`                                                                                | **PASS** | Exit 0 (`tsc --project tsconfig.build.json`).                                                                                                                                                                        |
| **Git Whitespace**                 | `git diff --check origin/main..HEAD`                                                           | **FAIL** | Exit 1. Trailing whitespace in `docs/audits/2026-11-04-fcd-support-audit-remediation.md:3` and `docs/audits/2026-11-04-fcd-support-executive-summary.md:3-6`.                                                        |
| **Security Policy Script**         | `node scripts/verify-security-policy.ts`                                                       | **PASS** | Exit 0. Inspected 297 tracked files; zero secret patterns detected. _(Note: requires execution from repository root)._                                                                                               |
| **UI/UX Contract Script**          | `node scripts/verify-ui-ux-contract.ts`                                                        | **PASS** | Exit 0. Audit mode (`strict=false`) caught 5 open UI/a11y items (`UI-A11Y-001`, `UI-TOUCH-002`, `UI-THEME-003`, `UI-RESP-004`, `UI-A11Y-005`).                                                                       |
| **SEO Contract Script**            | `node scripts/verify-seo-contract.ts`                                                          | **PASS** | Exit 0. Audit mode (`strict=false`) caught 2 open items (`SEO-ROBOTS-001`, `SEO-ROBOTS-002`).                                                                                                                        |
| **PR Handoff Script**              | `node scripts/verify-pr-handoff.ts`                                                            | **PASS** | Exit 0. Skips cleanly when `GITHUB_EVENT_PATH` is unset or non-PR event.                                                                                                                                             |
| **Branch Base Synchronization**    | `git diff --stat origin/main..HEAD`                                                            | **FAIL** | Branch diverged from `443d05b`; diff vs `origin/main` (`ab6036a`) deletes `docs/handoffs/2026-11-04-antigravity-observer-classification-corrections.md` and `docs/reviews/2026-11-04-pr-10-observability-review.md`. |
| **GitHub Actions CI (PR)**         | [Run 41859799938](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41859799938) | **FAIL** | Failed on `format:check` (`scripts/verify-pr-handoff.ts`, `SECURITY.md`).                                                                                                                                            |
| **GitHub Actions Agy Quality**     | [Run 41859800025](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41859800025) | **FAIL** | Failed on `format:check` (`scripts/verify-pr-handoff.ts`, `SECURITY.md`).                                                                                                                                            |
| **GitHub Actions Private Runtime** | [Run 41859800045](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41859800045) | **FAIL** | Failed on historical promotion failure present on base commit `ab6036a`.                                                                                                                                             |
| **GitHub Actions CodeQL**          | [Run 41859800167](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41859800167) | **PASS** | Advanced CodeQL analysis succeeded with immutable commit pin.                                                                                                                                                        |
| **GitHub Actions Agy UI/UX**       | [Run 41859799972](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41859799972) | **PASS** | Scaffold audit mode succeeded.                                                                                                                                                                                       |
| **GitHub Actions Agy SEO**         | [Run 41859800014](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41859800014) | **PASS** | Scaffold audit mode succeeded.                                                                                                                                                                                       |

---

## 3. Source & Evidence Accuracy Analysis

Every finding and claim across the audit deliverables was checked against `main` (`ab6036aff5c5b3211df1655c450780957b5e9f83`):

### 3.1. Phase 6 Operational & Runtime Findings (`FCD-P6-001` .. `FCD-P6-010`)

1. **`FCD-P6-001` (Scheduled-health held journal): `Verified`.**
   - _Finding:_ Server journal `2026-11-03-214436` has an open uncertain outcome on `health-transport-journal.json`.
   - _Evidence:_ Matches `docs/TODO.md` Task 16.1, `docs/PROJECT_CONTEXT.md` lines 53–56, and `docs/PLAN.md`. The hold is active and authoritative.
2. **`FCD-P6-002` (Dashboard grant correction deployed state): `Verified`.**
   - _Finding:_ PR #9 least privilege grant fixes are merged on `main` (`a14551d`), but deployed server state has not been redeployed/attested with live PostgreSQL grants because deployment is held behind the health hold and promotion verification.
   - _Evidence:_ Matches `docs/reviews/2026-11-04-pr-9-10-11-review.md`.
3. **`FCD-P6-003` (Promotion boundary / observer): `Verified` (with status update).**
   - _Finding:_ PR #10 promotion container/validator failure on GitHub Actions requires diagnosis; observer had false diagnostics (`samples.*`, exit 0, status 125–127).
   - _Evidence:_ Accurately reflects PR #10 review at `cb6985e`. Note that commit `c8304a2` on PR #10 has since addressed the 5 missing fields, 64-bit arithmetic overflow, and neutral exit formatting in the synthetic observer.
4. **`FCD-P6-004` (Timer configuration & ownership): `Verified`.**
   - _Finding:_ Timer unit files `fcd-support-health.timer` and `fcd-support-scheduled.timer` require strict file ownership (`root:root`, 0644), `Persistent=true`, and catch-up/replay verification.
   - _Evidence:_ Matches unit configurations in `infra/systemd/`.
5. **`FCD-P6-005` (Full-host reboot / recovery runbook): `Verified`.**
   - _Finding:_ Host reboot recovery is an essential Phase 6 launch gate criterion; container restart test alone is insufficient.
   - _Evidence:_ Confirmed by `docs/PLAN.md` Phase 6 verification requirements.
6. **`FCD-P6-006` / `FCD-P6-007` (Mode-aware runtime topology & secret mounts): `Verified`.**
   - _Finding:_ When `OUTBOUND_ENABLED=false`, container definitions and runtime must not mount Meta secrets or provide outbound network egress.
   - _Evidence:_ Confirmed in `infra/compose/docker-compose.yml` and `src/config/environment.ts`.
7. **`FCD-P6-008` (Manifest safeguards): `Verified`.**
   - _Finding:_ Model execution must remain disabled until recording-off, zero tools, prompt redaction, deletion/retention, provider allowlist, and deployment ceilings are verified.
   - _Evidence:_ Confirmed in `AGENTS.md` and `docs/PROJECT_CONTEXT.md`.
8. **`FCD-P6-009` / `FCD-P6-010` (Phase 7 & Phase 8 acceptance gap): `Deferred to Phase 7/8`.**
   - _Finding:_ `AC-01` through `AC-36` in `docs/PLAN.md` are readiness mappings, not live non-production execution proof. Production number cutover and WhatsApp coexistence decision belong to Phase 8.
   - _Evidence:_ Mapped correctly in `docs/PLAN.md` and `docs/TODO.md`. Live execution cannot occur until Phase 6 closes.

### 3.2. Repository Governance & Security Gaps (`FCD-REPO-001` .. `FCD-REPO-026`)

- **`FCD-REPO-001` .. `FCD-REPO-005` (Repository Configuration): `Verified` & resolved in PR #13.**
  - Boilerplate `SECURITY.md`, missing `.github/CODEOWNERS`, missing `.github/dependabot.yml`, missing PR template, and mutable CodeQL `@v7` action reference are correctly identified. PR #13 provides concrete implementations (subject to Prettier/ESLint fixes).
- **`FCD-REPO-006` .. `FCD-REPO-010` (CI Gates & Automation): `Verified` & scaffolded in PR #13.**
  - Dedicated gates for UI/WCAG and SEO, security policy scanning script, PR handoff validation, and Antigravity launch rules in `AGENTS.md` are correctly implemented as audit scaffolds (`strict=false`).
- **`FCD-REPO-011` .. `FCD-REPO-020` (Source Architecture & Error Durability): `Verified`; `Deferred to Gate 1 / Implementation`.**
  - Threading `AbortSignal` through health/readiness/workers (`FCD-REPO-011`), explicit worker shutdown states (`FCD-REPO-012`), persisting `delivery_unknown` for ambiguous sends (`FCD-REPO-013`), login/MFA rate-limiting (`FCD-REPO-014`), fail-closed cookie/origin checks (`FCD-REPO-015`), request timeouts and receipt concurrency limits (`FCD-REPO-016`), runtime PostgreSQL grant preflight check (`FCD-REPO-017`), fast unit test separation (`FCD-REPO-018`), backup restore allowlists (`FCD-REPO-019`), and current-status doc banners (`FCD-REPO-020`) represent real source-level defects that must be resolved prior to production launch.
- **`FCD-REPO-021` .. `FCD-REPO-026` (Accessibility & Header Boundaries): `Verified`; `Deferred to Gate 1 / UI Remediation`.**
  - `X-Robots-Tag: noindex, nofollow, noarchive` crawler isolation on webhooks and admin endpoints (`FCD-REPO-021`), skip-links to `#main-content` (`FCD-REPO-022`), 44px minimum touch targets (`FCD-REPO-023`), `prefers-color-scheme: dark` SOC theme (`FCD-REPO-024`), mobile table `data-label` attributes (`FCD-REPO-025`), and `role="alert"` on error banners (`FCD-REPO-026`) accurately identify real gaps in `src/admin/admin-html.ts`, `src/admin/operations-html.ts`, and `src/app.ts`.

### 3.3. Acceptance Criteria Mapping (`AC-01` .. `AC-36`)

All 36 criteria in `docs/PLAN.md` are accurately categorized:

- Criteria `AC-01` through `AC-36` correctly specify live non-production test asset behavior (Meta test number, HMAC verification, replay deduplication, stale event rejection, bilingual generation, human takeover suppression, opt-in/out, deletion/retention, backup-restore, and model fallback).
- Current status: **Deferred to Phase 7 Live Execution**; currently documented as readiness mappings.

### 3.4. Product Roadmap Features (`FCD-P0-001` .. `FCD-P2-004`)

- **P0 Launch Blockers (11 features): `Verified` as real functional gaps.**
  - Public Support & Trust Center, public status page, privacy portal, verified channel landing pages, media/quarantine pipeline, incident triage rubric, direct emergency notification failover, SLA timers, operator inbox/takeover composer, admin account lifecycle UI, and public abuse hardening.
- **P1 & P2 Enhancements (14 features): `Verified` as post-baseline enhancements.**
  - WhatsApp interactive buttons, attachment OCR/review, template sync, presence indicators, advanced localization, export capabilities, snapshot diff viewer, admin SSE stream, eval harness CI, and vector search.
- Status: Correctly prioritized into sequenced stories (`US-101` .. `US-105`).

---

## 4. Full Content vs. Condensed Summary Check

Comparison between the committed `docs/audits/*.md` deliverables and the full audit specifications reveals the following architectural differences:

1. **Executive Summarization vs. Itemized Catalogs:**
   - The committed audit files are high-level synthesis documents (~29 to 63 lines each).
   - `docs/audits/2026-11-04-fcd-support-audit-remediation.md` explicitly calls out `FCD-P6-001` through `FCD-P6-010`, but condenses `FCD-REPO-001` through `FCD-REPO-026` into narrative bullet points under "Source-level remediation backlog".
   - `docs/audits/2026-11-04-fcd-support-missing-features.md` condenses 25 product capabilities into 11 numbered P0 items, P1, and P2 lists without the full data contracts, JSON schemas, and security boundaries.
   - `docs/audits/2026-11-04-fcd-support-ui-ux-brand.md` summarizes the 15-viewport responsive matrix and WCAG criteria into concise guidance.
   - `docs/audits/2026-11-04-fcd-support-seo-geo.md` specifies the public SEO contract and JSON-LD schema requirements in outline format.
2. **Recommendation for In-Repo Traceability:**
   - Retain the committed `docs/audits/*.md` synthesis files as the clean executive summary.
   - When executing stories `US-101` through `US-105`, embed the itemized technical specifications, mockups, data contracts, and verification criteria directly into their corresponding handoffs and pull request descriptions so no requirements are lost.

---

## 5. Prioritized Action Plan & Next Steps

### Step 1: Corrections Required on PR #13 Branch (`codex/agy-ci-and-repo-governance`)

1. **Format Code & Docs with Prettier:**
   - Run `npx prettier --write SECURITY.md scripts/verify-pr-handoff.ts` to fix table formatting and statement wrapping.
2. **Fix Trailing Whitespace:**
   - Remove trailing whitespace on line 3 of `docs/audits/2026-11-04-fcd-support-audit-remediation.md` and lines 3–6 of `docs/audits/2026-11-04-fcd-support-executive-summary.md` so `git diff --check` exits with 0.
3. **Fix ESLint Violation:**
   - In `scripts/verify-security-policy.ts`, change lines 36–38:
     ```typescript
     for (const relativePath of trackedFiles) {
       let content: string;
       try {
         content = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
       } catch {
         continue;
       }
     ```
     This resolves the `no-useless-assignment` error.
4. **Merge Fresh `main` (`ab6036aff5c5b3211df1655c450780957b5e9f83`):**
   - Synchronize the branch with `main` to eliminate spurious file deletions in git diff.
5. **Retain Draft Status:**
   - Keep PR #13 in draft until all CI checks pass.

### Step 2: Immediate Local Execution Stories

Following PR #13 review and PR #10 observer resolution, work should proceed on the approved bounded stories in isolated worktrees:

- **`US-101` (Admin Account Lifecycle UI):**
  - Implement admin user creation, role assignment, password rotation, MFA reset, and session revocation in `src/admin/` with strict CSRF and audit event recording.
- **`US-102` (Operator Inbox & Human Takeover Reply Composer):**
  - Implement conversation message timeline with redaction, takeover state toggle, and role-gated reply dispatch.
- **`US-103` (Direct Emergency Notification Failover):**
  - Implement independent notification failover path (HMAC webhook/email/Telegram) bypassing n8n for high-severity security incidents.
- **`US-104` (Incident Triage Rubric & SLA Scheduler):**
  - Implement deterministic incident severity scoring, SLA deadline tracking, and reminder escalation.
- **`US-105` (Public Support & Trust Center):**
  - Implement separate read-only public renderer for bilingual FAQ, status, privacy requests, and verified channel links.
