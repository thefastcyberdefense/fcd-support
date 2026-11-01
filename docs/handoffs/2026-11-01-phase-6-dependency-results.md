# Phase 6 Dependency Follow-up Results

Date: 2026-11-01 (Asia/Dhaka).
Author: Antigravity (AGY).
Worktree: `J:\DevDrive\fcd-support-agy-failure-matrix`.
Branch: `codex/agy-p6-dependency-followup`.
Base Revision: `4d39aa0359632cd08794c039ec38b8d52d42c1c2`.
Primary Checkout Untouched: `J:\DevDrive\fcd-support` on `main` at `4d39aa0359632cd08794c039ec38b8d52d42c1c2`.

---

## 1. Executive Summary & Advisory Triage

Following the integration of PR #3 (`df8e52dbe59e0013ab28a5790b21c9785324b2f0`, tested source `78013148751a493a6f8859bc6d3ee9628cb954d6`), GitHub reported two medium runtime-transitive alerts in the dependency chain of `node-pg-migrate@9.0.0`. In accordance with `docs/handoffs/2026-11-01-antigravity-dependency-followup.md` and `docs/superpowers/plans/2026-11-01-phase-6-dependency-followup.md`, AGY performed an independent primary-source evaluation and implemented a minimal, scoped, pinned override that eliminates both vulnerable copies from the production runtime tree while preserving strict API compatibility and zero regressions.

### Finding 1: CVE-2026-118773 / GHSA-3g3m-2fjr-6pw4 (`glob@13.0.6`)
- **Severity:** Moderate
- **Title:** Glob AbortSignal cancellation bypass allows post-timeout filesystem traversal
- **Vulnerable Range:** `3.0.0 - 14.0.1`
- **Reported Patched Floor:** `14.0.2`
- **Upstream Direct Parent:** `node-pg-migrate@9.0.0` declares `glob: "~13.0.0"`. Upstream has not released any 9.x patch or 10.x stable release targeting `glob@14` (the latest alpha `10.0.0-alpha.7` still declares `glob: "~13.0.0"`).
- **Reachability & Boundary Evidence:**
  - In `src/operations/forward-migration.ts`, `runForwardMigrations` invokes `runner({ dir: directory, ... })` where `directory = resolve('migrations')` is a fixed, absolute directory path.
  - `useGlob` is not passed and defaults to `false`.
  - When `useGlob` is false, `node-pg-migrate` executes `node:fs/promises` `readdir` and does not invoke `glob(...)`.
  - No `signal` / `AbortSignal` is supplied to `runner` or `glob`.
  - Forward migrations run only in isolated private maintenance / operations containers; they are never reachable from public webhook or unauthenticated ingress routes.
  - Package presence alone did not establish an exploitable public path; however, resolution via a supported scoped override prevents lingering audit alerts.

### Finding 2: CVE-2026-118764 / GHSA-g3hv-75wg-m249 (`minimatch@10.2.6`)
- **Severity:** Moderate
- **Title:** minimatch potential denial of service via globparts amplification
- **Vulnerable Range:** `<11.0.1`
- **Reported Patched Floor:** `11.0.1`
- **Upstream Direct Parent:** `glob@13.0.6` declared `minimatch: "^10.2.2"`.
- **Reachability & Boundary Evidence:**
  - Transitive dependency of `glob@13.0.6` under `node-pg-migrate`.
  - As established above, `node-pg-migrate` does not invoke `glob` or parse untrusted glob expressions in `runForwardMigrations`.
  - Top-level `minimatch@10.2.6` is retained solely under devDependencies (`eslint@10.8.0`, `@typescript-eslint/typescript-estree@8.65.0`). These are dev-only and outside the production runtime container (`--omit=dev`). Forcing `minimatch@11` across ESLint would violate declared peer ranges.

---

## 2. Minimal Scoped Pinned Override

Rather than attempting an unverified major upgrade of `node-pg-migrate`, running destructive `npm audit fix --force` (which proposes an unsupported breaking downgrade to `node-pg-migrate@7.6.1`), or widening dependency ranges, we applied an exact, scoped pinned override in `package.json`:

```json
  "overrides": {
    "node-pg-migrate": {
      "glob": "14.0.3",
      "minimatch": "11.0.3"
    }
  }
```

### Lockfile Changes (`package-lock.json`):
- `node_modules/glob`: Pinned from `13.0.6` to `14.0.3` (exceeds patched floor `14.0.2`).
- `node_modules/glob/node_modules/minimatch`: Added at `11.0.3` (exceeds patched floor `11.0.1`).
- `node_modules/@isaacs/nonrecursive-glob-match`: Added at `1.0.3` (dependency of `minimatch@11.0.3`).
- `node_modules/path-scurry`: Pinned from `2.0.2` to `3.0.0` (dependency of `glob@14.0.3`).
- `node_modules/lru-cache`: Updated from `11.5.2` to `11.5.3`.
- `node_modules/minimatch`: Retained at `10.2.6` for dev-tooling only (`"dev": true`).

### Compatibility Verification:
- **Node Engine Support:** `glob@14.0.3` requires `"node": "18 || 20 || >=22"`, fully compatible with repository engine `>=24.17.0 <25`.
- **API Surface:** Tested `node-pg-migrate` file resolution directly under Node 24:
  - `getMigrationFilePaths('migrations', { useGlob: false })`: resolves all 16 migration files via `node:fs/promises`.
  - `getMigrationFilePaths('migrations/*', { useGlob: true })`: resolves all 16 migration files via `glob@14.0.3`.
- **Runtime Dependency Audit:** `npm audit --omit=dev` and `npm audit --omit=dev --audit-level=high` both report **found 0 vulnerabilities**.

---

## 3. Local Verification Commands and Results

| Command | Suite / Target | Result | Duration | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `npm run validate:phase0` | Phase 0 gate validation | **PASSED** (code 0) | ~1.5s | Trackers, evidence, and authority boundary valid |
| `npm run format:check` | Prettier code style | **PASSED** (code 0) | ~6.5s | All matched files use Prettier style |
| `npm run lint` | ESLint strict rules | **PASSED** (code 0) | ~25.0s | Zero errors, zero warnings |
| `npm run typecheck` | TypeScript (`tsc --noEmit`) | **PASSED** (code 0) | ~10.0s | Zero type errors |
| `npm run build` | TypeScript build (`tsc -p tsconfig.build.json`) | **PASSED** (code 0) | ~9.5s | Build output updated cleanly |
| `npm audit --omit=dev --audit-level=high` | Production dependency audit | **PASSED** (code 0) | ~2.5s | Zero high/critical vulnerabilities |
| `npm audit --omit=dev` | Complete production dependency audit | **PASSED** (code 0) | ~2.5s | **Zero vulnerabilities** (moderate alerts resolved) |
| `VITEST_MAX_WORKERS=4 npm run check` | Full local gate (validate, lint, test, build) | **1,952 passed / 438 platform skips / 0 failed / 0 timeouts** | 238.05s | 117 passed files, 14 integration skips (131) |
| `npx vitest run tests/restore-migrate-command.test.ts` | Restore migrate CLI unit test | **7 passed** | 1.01s | Zero regressions |
| `npx vitest run tests/process-lifecycle.test.ts tests/backup-harness-containment.test.ts tests/systemd-contract.test.ts` | Phase 6 Task 15 review suites | **80 passed / 8 platform skips** | 19.33s | Zero regressions |
| `python -B docs/operations/actions/2026-10-29-promotion-observer-test.py` | Promotion observer | **32 passed / 1 platform skip** (Windows symlink) | 1.228s | Hermetic stdlib tests |
| `python -B docs/operations/actions/2026-10-31-reboot-recovery-test.py` | Reboot recovery helper | **11 passed / 0 skips** | 0.069s | Hermetic stdlib tests |
| `python -B docs/operations/actions/2026-10-31-peer-recovery-test.py` | Peer recovery helper | **11 passed / 0 skips** | 0.039s | Hermetic stdlib tests |
| `python -B docs/operations/actions/2026-10-31-rollback-after-reboot-test.py` | Rollback helper | **6 passed / 0 skips** | 0.034s | Hermetic stdlib tests |
| `python -B docs/operations/actions/2026-10-31-current-runtime-recovery-test.py` | Current runtime recovery helper | **5 passed / 0 skips** | 0.271s | Hermetic stdlib tests |

---

## 4. Referenced Commit Provenance

All quoted Git commit references verified with `git cat-file -e '<sha>^{commit}'`:
- PR #3 Squash Merge: `df8e52dbe59e0013ab28a5790b21c9785324b2f0`
- Tested Source Commit: `78013148751a493a6f8859bc6d3ee9628cb954d6`
- Integration Docs Commit: `83b8e97843614f8d510d71aff3314aaee1c55efb`
- Base Revision on Synchronized Main: `4d39aa0359632cd08794c039ec38b8d52d42c1c2`

---

## 5. Governance & Next Steps

1. **Codex Review & Disposition:**
   - This change is submitted as a separate draft PR on branch `codex/agy-p6-dependency-followup`.
   - Codex retains authoritative ownership over whether to merge this scoped override or document an alternative formal disposition.
2. **Phase 6 Evidence Pack Continuation:**
   - Once Codex completes review/disposition of this dependency follow-up, AGY will continue with `docs/handoffs/2026-11-01-antigravity-phase-6-evidence-pack.md` on a fresh branch from fresh synchronized main.
   - P6-GATE and Task 16 remain OPEN; no server deployment or live actions executed.
