# Fast Cyber Defense Support (`fcd-support`) - Antigravity GitHub Actions & Repository Governance

- **Audited Revision (`main`):** [`16678546ec9ae6305ba750016da5b1ba604cf9ac`](https://github.com/thefastcyberdefense/fcd-support/commit/16678546ec9ae6305ba750016da5b1ba604cf9ac)
- **Branch:** `codex/agy-ci-and-repo-governance` (Draft PR #13)

## Governance Gaps Addressed in PR #13

Before PR #13, `main` had a GitHub-template placeholder `SECURITY.md`, no `.github/CODEOWNERS`, no `.github/dependabot.yml`, no `.github/pull_request_template.md`, a mutable `actions/checkout@v7` tag in `.github/workflows/codeql.yml`, and no automated check for PR handoff sections or synthetic-fixture policy patterns.

## Implemented in PR #13 (and Exact Enforcement Boundaries)

1. **`SECURITY.md`:** Replaces the template placeholder with `fcd-support` webhook/privacy trust boundaries and directs vulnerability reports to GitHub Private Vulnerability Reporting or the repository owner (`@redwan-cse`), while explicitly marking proposed security mailbox addresses (`security@fastcyberdefense.com`), 24h/48h response SLAs, and safe-harbor text as **proposals pending owner/legal provenance approval**.
2. **`AGENTS.md`:** Documents the exact scope of the three `agy-*` workflows while preserving webhook-only public exposure (`GET/POST /webhooks/meta`) and approved FAQ precedence + tool-free Manifest `fcd-support` (`model: "auto"`) fallback.
3. **`.github/CODEOWNERS` & `.github/dependabot.yml`:** Adds code-ownership mapping for high-risk paths and weekly Dependabot updates for `npm` and `github-actions`. **Note:** Committing `.github/CODEOWNERS` does not automatically configure GitHub branch protection; branch-protection rules remain a repository-settings action for the owner.
4. **`.github/workflows/codeql.yml`:** Preserves all existing CodeQL comments, triggers (`push`, `pull_request`, weekly `schedule`), permissions, and `actions` + `javascript-typescript` matrix from `main`, pins `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6` with `persist-credentials: false`, and explicitly notes that `github/codeql-action/init@v4` and `github/codeql-action/analyze@v4` remain on mutable `@v4` major tags.
5. **`.github/workflows/agy-quality-and-security-gate.yml` (Blocking Static & Pattern Gate):** Runs `npm run validate:phase0`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev --audit-level=high`, `node scripts/verify-security-policy.ts`, and (on `pull_request` events) `node scripts/verify-pr-handoff.ts`.
6. **`scripts/verify-security-policy.ts` (Heuristic Pattern Scanner — Tested in `tests/governance-scripts.test.ts`):**
   - **What it checks:** Verifies `SECURITY.md` and `AGENTS.md` required policy strings and scans all tracked non-binary repository files—including `docs/` and `tests/` (excluding only `package-lock.json` and binary extensions)—for PEM private-key headers, high-risk token prefixes (`EAAB...`, `ghp_...`, `github_pat_...`, `sk-proj-...`, `sk-live-...`, `xox[baprs]-...`), and non-synthetic inline secret assignments, while allowing narrow synthetic sentinels (`SYNTHETIC_` / `TEST_` markers per `docs/SYNTHETIC_FIXTURE_POLICY.md` and regex definitions in allowlisted source/scanner files). Fails closed on unreadable tracked files and suppresses matched values in all outputs.
   - **Explicit limitations:** This is a heuristic regex/keyword scanner; it does **not** prove synthetic-fixture provenance or guarantee the absence of all secrets across the repository.
7. **`scripts/verify-pr-handoff.ts` (PR Section & Command-Token Checker — Tested in `tests/governance-scripts.test.ts`):**
   - **What it checks:** When `GITHUB_EVENT_PATH` points to a pull request payload, verifies that the PR body contains non-empty, non-placeholder `## Summary`, `## Validation` (including concrete validation command and outcome tokens), and `## Evidence` or `## Scope` sections after stripping template prompts, unchecked checkboxes, and `TODO`/`TBD` stubs. When `GITHUB_EVENT_PATH` is unset or non-PR, prints `SKIP:` and returns `status: 'skipped'`. Fails closed on unreadable or malformed event JSON.
   - **Explicit limitations:** Heading and token checks do **not** verify that linked artifacts exist, that a story is approved in ClickUp, or that validation commands actually passed in CI.
8. **`scripts/verify-ui-ux-contract.ts` & `scripts/verify-seo-contract.ts` (Non-Blocking Source-Text Scaffolds, `strict=false`):**
   - **What they check:** Inspect template and header strings in `src/admin/admin-app.ts` and `src/app.ts` and emit `[WARN]` notices when `AGY_STRICT_UI_GATE=false` / `AGY_STRICT_SEO_GATE=false` (the default).
   - **Explicit limitations:** They do **not** launch a browser, test responsive viewports (`320x568`..`1920x1080`), measure horizontal overflow, run axe WCAG 2.2 AA rules, or verify live routes/metadata. Playwright/axe/Lighthouse browser gates remain explicit future work.
