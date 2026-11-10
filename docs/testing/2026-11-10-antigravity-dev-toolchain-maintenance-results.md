# Compatible Development-Tool Maintenance Results

Date: 2026-11-10 (Asia/Dhaka)
Task: [`docs/handoffs/2026-11-10-antigravity-dev-toolchain-maintenance.md`](../handoffs/2026-11-10-antigravity-dev-toolchain-maintenance.md)
Status: Draft PR submitted from clean `main` (`88de2ee`); local validation complete, disposable GitHub Actions CI pending push.

## Provenance and Authority Boundaries

- **Repository base (`main`):** `88de2eeb693c08559e57295aa6ca8d1cd27bd104` (includes accepted governance merge `6091621` and accepted runtime merge `d4cfddd`).
- **Branch & Worktree:** `codex/agy-dev-toolchain-maintenance` in isolated worktree `J:\DevDrive\fcd-support-dev-toolchain`.
- **Node / npm Toolchain:** `.node-version` `24.18.0`, `package.json` `engines.node` `>=24.17.0 <25`, `packageManager` `npm@11.16.0`; local verification executed on Node `v24.19.0`, npm `11.17.0`.
- **Primary Sources & Package Metadata:**
  - `eslint`: [`https://eslint.org`](https://eslint.org), [`https://github.com/eslint/eslint`](https://github.com/eslint/eslint), tarball [`https://registry.npmjs.org/eslint/-/eslint-10.14.0.tgz`](https://registry.npmjs.org/eslint/-/eslint-10.14.0.tgz) (published `2026-10-30T14:12:27.179Z`, `engines.node`: `^20.19.0 || ^22.13.0 || >=24`).
  - `typescript-eslint`: [`https://typescript-eslint.io/packages/typescript-eslint`](https://typescript-eslint.io/packages/typescript-eslint), [`https://github.com/typescript-eslint/typescript-eslint`](https://github.com/typescript-eslint/typescript-eslint), tarball [`https://registry.npmjs.org/typescript-eslint/-/typescript-eslint-8.68.0.tgz`](https://registry.npmjs.org/typescript-eslint/-/typescript-eslint-8.68.0.tgz) (published `2026-08-24T17:27:29.554Z`, `engines.node`: `^18.18.0 || ^20.9.0 || >=21.1.0`, `peerDependencies.eslint`: `^8.57.0 || ^9.0.0 || ^10.0.0`, `peerDependencies.typescript`: `>=4.8.4 <6.1.0`).
- **Scope Preserved:** Edits are strictly limited to `package.json` (`eslint` and `typescript-eslint`), `package-lock.json`, and this dated results file. Zero changes to `src/`, `migrations/`, `scripts/`, `infra/`, `eslint.config.js`, production dependencies, overrides, runtime behavior, UI, SEO, server state, or GitHub security alerts.

## Compatible Refresh Applied and Evaluated Boundaries

1. **Applied Current-Major Dev Updates (`package.json`):**
   - `eslint`: `10.8.0` (`2026-07-24T20:15:20.693Z`) -> **`10.14.0`** (`2026-10-30T14:12:27.179Z`). Refreshes ESLint to the current `10.x` release (`file-entry-cache` `8.0.0 -> 11.1.5`, `@eslint/plugin-kit` `0.7.2 -> 0.7.3`, `flat-cache` `4.0.1 -> 6.1.23`, `keyv` `4.5.4 -> 5.6.0`, cache helpers) with zero lint or config breakage.
   - `typescript-eslint`: `8.65.0` (`2026-07-20T17:39:32.402Z`) -> **`8.68.0`** (`2026-08-24T17:27:29.554Z`). Updates `typescript-eslint` and all 10 aligned `@typescript-eslint/*` packages cleanly under `eslint.config.js` (`recommended`, `strictTypeChecked`, `stylisticTypeChecked`).
2. **Tested Compatibility Boundaries Above `8.68.0` (Stopped Without Source/Rule Weakening):**
   - `typescript-eslint@8.69.0` (`2026-08-31T17:08:46.355Z`) through `8.71.2`: fails `npm run lint` with **12 errors** under `@typescript-eslint/no-meaningless-void-operator` (`#12727` reporting `void` on non-call expressions across `src/operations-main.ts`, `src/operations/backup-command.ts`, `src/operations/backup.ts`, `src/operations/promotion-host.ts`, `tests/integration/postgres-consent-policy.test.ts`, `tests/integration/postgres-deletion-checkpoint.test.ts`, `tests/integration/postgres-encrypted-backup.test.ts`, `tests/policy/consent-command.test.ts`, and `tests/reply-decision-service.test.ts`).
   - `typescript-eslint@8.72.0` through `8.72.2` (`2026-11-09T17:08:00.049Z`): additionally fails `npm run lint` with **1 error** under `@typescript-eslint/no-deprecated` (`#12704` flagging `verbatim: true` in `src/notifications/n8n-client.ts:233`), totaling **13 lint errors**.
   - Preserving strict lint semantics and avoiding out-of-scope source/test edits stops `typescript-eslint` at `8.68.0`. Adopting `8.69.0+` / `8.72.2` is a straightforward follow-up PR touching those 8 source/test files.
3. **Evaluated Remaining Pinned Packages (Unchanged):**
   - **Production pins & scoped overrides:** `fastify@5.12.7`, `node-pg-migrate@9.0.0`, `pg@8.22.0`, `zod@4.6.7`, and `"overrides": { "node-pg-migrate": { "glob": "14.0.3", "minimatch": "11.0.3" } }` remain completely unchanged.
   - **Dev pins left unchanged:** `@eslint/js@10.0.1` (already `latest`); `typescript@6.0.3` (latest `6.0.x`; `7.0.2` is a major bump incompatible with `typescript-eslint@8.x` `peerDependencies` `<6.1.0`); `vitest@4.1.12` / `@vitest/coverage-v8@4.1.12` (latest `4.x`; `5.1.0` is a major upgrade requiring separate validation); `prettier@3.9.6` (`3.9.10` available), `@types/node@24.13.3` (`24.19.2` available on Node 24 line; `26.6.6` is outside `<25`), and `@types/pg@8.21.0` (`8.23.1` available) were left untouched as non-lint/parser dependencies.

## Dependency Graph, Lockfile Diff, and Audit Scopes

- **Lockfile package summary (`package-lock.json`):** `263` -> `271` total entries (`27` dev-only entry changes: `17` updated/moved `dev: true` entries, `9` new transitive cache subpackages with `dev: true`, `1` removed `dev: true` package `json-buffer@3.0.1`). **`prodChanged` count: `0`.**
- **Production `--omit=dev` pruning check (`npm ci --omit=dev --ignore-scripts` in isolated clean directory):**
  - Installs exact **`95` production packages** (`node_modules/fastify@5.12.7`, `node_modules/node-pg-migrate@9.0.0`, `node_modules/pg@8.22.0`, `node_modules/zod@4.6.7`, `node_modules/glob@14.0.3`, `node_modules/glob/node_modules/minimatch@11.0.3`).
  - Prunes development `node_modules/minimatch@10.2.6` cleanly (`Test-Path node_modules/minimatch` == `False`).
- **Upstream transitive range constraint (`eslint` / `typescript-eslint`):**
  - Stable `eslint@10.14.0` declares `"minimatch": "^10.2.6"` and `"@eslint/config-array": "^0.23.5"` (`"minimatch": "^10.2.4"`); stable `@typescript-eslint/typescript-estree` (`8.65.0`, `8.68.0`, and `8.72.2`) declares `"minimatch": "^10.2.2"`.
  - Highest matching release on npm under `^10.2.x` is `minimatch@10.2.6`. `minimatch@11.x` (`11.0.1`–`11.0.5`) is a major semver release; only the `typescript-eslint` prerelease `canary` tag (`8.72.3-alpha.3`, `2026-11-10T00:44:22.145Z`) currently targets `"minimatch": "^11.0.1"`.
  - Consistent with project policy, no broad `npm audit fix --force` downgrade (which proposes downgrading `eslint` to `9.39.5`), no global transitive major override, and no prerelease pin was introduced.
- **Audit Scope Distinction (per `SECURITY.md`):**
  - **Production scope (`npm audit --omit=dev --audit-level=high` and `npm audit --omit=dev`):** exit **`0`**, **`0` vulnerabilities** (`95` prod / `96` audited items in `--omit=dev`).
  - **Full workspace audit (`npm audit` across `271` dependencies):** exit **`1`** (`10` moderate severity items confined to `dev: true` lint subtrees; `0` info, `0` low, `0` high, `0` critical). Specific advisory details and alerts are kept private per [`SECURITY.md`](../../SECURITY.md).

## Validation Results

Executed cleanly from `package-lock.json` via `npm ci --ignore-scripts` on Node `v24.19.0` / npm `11.17.0` in `J:\DevDrive\fcd-support-dev-toolchain`:

- `npm ci --ignore-scripts` — PASS (`exit 0`; `246` packages installed).
- `npm run validate:phase0` — PASS (`Phase 0 tracker, evidence, citations, launch-gate mappings, and authority boundary are valid.`).
- `npm run format:check` — PASS (`All matched files use Prettier code style!`).
- `npm run lint` — PASS (`eslint .` exited `0`; zero errors or warnings).
- `npm run typecheck` — PASS (`tsc --noEmit` exited `0`).
- `npm run build` — PASS (`tsc --project tsconfig.build.json` exited `0`).
- `npx vitest run --maxWorkers=4` — PASS (`121 test files passed | 14 Linux/PostgreSQL-only skipped (135)`; **`2,212 passed | 461 skipped (2,673)`** in `251.02s`). Note: an earlier unbounded-worker `npx vitest run` during initial `8.72.2` probing hit the pre-existing Windows MSYS2 harness timeout/reap contention addressed separately in PR #18 (`operations-promotion-diagnosis` 1 fail, `operations-promotion-controller` 3 fails before cancellation).
- `node scripts/verify-security-policy.ts` — PASS (`732` tracked files inspected; heuristic pattern scan only).
- `node scripts/verify-ui-ux-contract.ts` — exit `0` non-blocking scaffold (`5 open item(s); strict=false; source-text check only`; certifies no rendered WCAG/browser behavior).
- `node scripts/verify-seo-contract.ts` — exit `0` non-blocking scaffold (`2 open item(s); strict=false; source-text header check only`; certifies no live metadata/route behavior).
- `node scripts/verify-pr-handoff.ts`:
  - Without `GITHUB_EVENT_PATH`: `SKIP: GITHUB_EVENT_PATH not set; PR handoff structure check skipped (not enforced in non-PR context).` (exit `0`).
  - With synthetic UTF-8 PR event payload matching real `pull_request` CI: verified PASS prior to Draft PR creation.
- `git diff --cached --check` — PASS (`0` whitespace issues).

## Remaining Gaps and Authority Statement

- Compatible validation of `eslint@10.14.0` + `typescript-eslint@8.68.0` proves dependency and static/unit compatibility only; it does not approve production launch, new runtime features, browser accessibility compliance, or shared-server changes.
- Disposable GitHub Actions CI (`ci`, `PostgreSQL and native operations`, `Private runtime controller`, `CodeQL Advanced`, `agy quality and security gate`) will be verified upon Draft PR submission and linked in the PR record.
