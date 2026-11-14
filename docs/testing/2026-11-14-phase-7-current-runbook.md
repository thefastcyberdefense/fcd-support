# Phase 7 Current-Runtime Test Runbook Validation Record

Date: 2026-11-14 (Asia/Dhaka).

Base source: `94c95423feed20c866c9ab4a009ddde146674f57` (`origin/main`, containing accepted PR #18 merge `f6ca679`, PR #19 merge `2e24997`, `5ede82c`, and `ba85e77`).

Branch: `codex/agy-phase-7-current-runbook`.

Handoff: [2026-11-11-antigravity-phase-7-runbook.md](../handoffs/2026-11-11-antigravity-phase-7-runbook.md).

## Deliverables

- Authoritative runbook: [phase-7-current-runtime-test-runbook.md](../operations/phase-7-current-runtime-test-runbook.md)
- Companion validation record: [2026-11-14-phase-7-current-runbook.md](./2026-11-14-phase-7-current-runbook.md)

Documentation-only consolidation: zero changes to `src/`, `scripts/`, `infra/`, `migrations/`, `tests/`, `package.json`, `package-lock.json`, `vitest.config.ts`, `docs/TODO.md`, or `docs/PROJECT_CONTEXT.md`. Zero tracker rows or launch gates are closed.

## Evidence Classification Separation

| Evidence Scope | Exact Reference | Observed Status | What Remains Unproven |
| --- | --- | --- | --- |
| Current source on `main` | `94c9542` (incl. `f6ca679`, `2e24997`, `5ede82c`, `ba85e77`) | Source contracts, schemas, Admin RBAC/MFA/CSRF, FAQ/model/outbound/privacy logic verified locally in this branch (`docs/` only added) | Does not deploy the server stack or settle live Phase 7 acceptance |
| Historical Phase 3 live check | Revision `207a5e6` (`docs/operations/test-deployment.md`) | Historical webhook GET/POST HMAC verification, `401` rejection, and synthetic `v26` payload tests on legacy stack | Does not establish current `94c9542` private runtime, worker execution, or device delivery |
| Held Phase 6 private stack | Revision `24e5667` (`docs/testing/2026-11-03-phase-6-server-24e5667.md`) | Root timers active and `webhook`/`reply`/`postgres` healthy on private test project | `admin` unhealthy/restarting; held uncertain health journal requires separate Codex disposition |
| Read-only successor preflight | Revision `5ede82c` (`docs/testing/2026-11-13-private-successor-admission.md`) | Non-mutating preservation checks passed (`23` unrelated containers and legacy `207a5e6` intact) | Refused at `resources` (`10 GiB` free vs `12 GiB` admission floor; `-1,609 MiB` deficit) |
| Local/CI checks on this branch | `codex/agy-phase-7-current-runbook` (see Validation table below) | Documentation links, static/governance/security checks, and two-worker Windows Vitest pass; Linux CI checked on Draft PR | Docs-only branch retains unpatched `94c9542` `tests/` (failed `4` cases on 4-worker Windows); 2-worker & Linux do not substitute for 4-worker Windows |
| Live Phase 7 runtime sequence (`T-01`–`T-11`) | `P7-005` / `P7-GATE` | **UNEXECUTED** (readiness `BLOCKED` pending disk remediation, health-job disposition, and isolated deployment) | All live webhook, device, Manifest, AI takeover, privacy reviewer, outage, and restore drills |

## Documented Code/Tooling Gaps and Reconciliations

1. **Gap G-1 — Signed Synthetic Webhook Probe CLI**: No standalone script in `scripts/` or `src/` signs and submits synthetic `X-Hub-Signature-256` Meta webhook requests. Live `T-01`, `T-03`/`T-04` webhook probes, and `T-07`/`T-08` require a temporary scratch signer computing SHA-256 HMAC over exact UTF-8 JSON bytes or Meta App Dashboard test-event delivery.
2. **Gap G-2 — Interactive AI Resume & Privacy/Consent Reviewer UI/CLI**: PostgreSQL store policies exist (`PostgresTakeoverPolicy`, `PostgresDeletionPolicy`, `PostgresPrivacyRightsPolicy`, `PostgresMarketingOptOutPolicy`), and `node dist/operations-main.js deletion` / `retention` handle background sweeps, but no HTTP Admin route in `src/admin/admin-app.ts` and no `src/operations-main.ts` subcommand interactively resumes paused conversations or approves `DELETE MY DATA` / `REQUEST MY DATA` / `CORRECT MY DATA` / selective marketing re-opt-in requests. Documented as a blocker/manual-maintenance gap for `T-06` and `T-08`.
3. **Gap G-3 — Content-Free DB Proof Wrapper**: No dedicated read-only `ops db-counts` wrapper exists; `T-01`–`T-11` specify content-free aggregate SQL counts/enums executed inside the private maintenance PostgreSQL scope.
4. **Graph API Version Pin Reconciliation**: Outbound code remains pinned at `META_GRAPH_API_VERSION = 'v25.0' as const` (`src/outbound/outbound-config.ts#L13`, `src/outbound/meta-outbound-client.ts#L132`; official Meta `v25.0` released `2026-02-18` and supported through `2028-07-29`, while `v26.0` released `2026-07-29`). The runbook retains `'v25.0'` verbatim for `P7-005` and defers any upgrade evaluation to `P8-002` ([`docs/TODO.md`](../TODO.md)).
5. **UI/UX and SEO Static Scaffold Distinction**: `node scripts/verify-ui-ux-contract.ts` (`5` open source-text items: `UI-A11Y-001`, `UI-TOUCH-002`, `UI-THEME-003`, `UI-RESP-004`, `UI-A11Y-005`, `strict=false`) and `node scripts/verify-seo-contract.ts` (`2` open source-text items: `SEO-ROBOTS-001`, `SEO-ROBOTS-002`, `strict=false`) are static scaffolds only; neither replaces live operator browser verification across all seven sidebar routes in `T-02`.

## Local Validation Command Results

Observed validation results across final documentation edits (static, governance, security, and link checks re-run cleanly on staged bytes; Vitest full runs observed on unpatched `94c9542` base checkout since docs-only changes do not alter executable test paths):

- **Static, governance, security, and link checks on staged docs**:
  - `npm run validate:phase0`: passed (`Phase 0 tracker, evidence, citations, launch-gate mappings, and authority boundary are valid.`).
  - `npm run format:check`: passed (`All matched files use Prettier code style!`).
  - `npm run lint`: passed (`eslint .`, exit `0`).
  - `npm run typecheck`: passed (`tsc --noEmit`, exit `0`).
  - `npm run build`: passed (`tsc --project tsconfig.build.json`, exit `0`).
  - `npm audit --omit=dev --audit-level=high`: passed (`found 0 vulnerabilities`).
  - `node scripts/verify-security-policy.ts`: passed (`754 tracked files inspected across source, docs, and tests`; heuristic pattern scan only).
  - `git diff --cached --check`: passed (exit `0`).
  - Relative Markdown link and `#L...` line-anchor check across both deliverables: `28` local links checked, `0` errors.
- **Unpatched `94c9542` four-worker Vitest (`$env:VITEST_MAX_WORKERS='4'; npm test`)**: `Test Files 2 failed | 121 passed | 14 skipped (137)`, `Tests 4 failed | 2248 passed | 461 skipped (2713)`, `282.54s`, exit `1`. Failures occurred strictly in unpatched `94c9542` harness capture/containment (`backup-harness-containment.test.ts` stalled-child and interrupted-barrier `test_child_reap_unconfirmed`, plus `operations-promotion-controller.test.ts` `3500ms` timeout and interrupted-barrier `test_child_reap_unconfirmed`), which are addressed separately in sibling branch `codex/agy-windows-capture-consistency` (Draft PR #22) and left untouched here to preserve docs-only scope.
- **Unpatched `94c9542` two-worker Vitest (`$env:VITEST_MAX_WORKERS='2'; npm test`)**: `Test Files 123 passed | 14 skipped (137)`, `Tests 2252 passed | 461 skipped (2713)`, `328.59s`, exit `0`. (Distinct from four-worker parity and Linux CI.)
- **UI/UX and SEO static scaffolds**:
  - `node scripts/verify-ui-ux-contract.ts`: exited `0` (`5 open item(s); strict=false`).
  - `node scripts/verify-seo-contract.ts`: exited `0` (`2 open item(s); strict=false`).
- **Live Phase 7 test commands (`T-01`–`T-11`, `deploy-runtime.sh`, `verify-runtime.sh`, `run-operation.sh`, `restore-runtime.sh`, `promote-restore.sh`, `admin:bootstrap`, signed Meta webhook probes)**: **UNEXECUTED** in this task (shared-host SSH, Docker daemon, tunnel, Meta, and Manifest operations are out of scope and blocked by host storage deficit + held Phase 6 job).
