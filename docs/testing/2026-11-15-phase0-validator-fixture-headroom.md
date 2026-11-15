# Phase 0 Validator Bounded Fixture Headroom Evidence (2026-11-15)

- **Branch / Base:** `codex/agy-phase0-validator-headroom` (based on clean `origin/main` @ `c2d8225d2a096e2d4f406c35f8ab170a6dad2f80`)
- **Strict Scope (2 files vs `origin/main`):**
  - [`tests/phase0-gate-validator.test.ts`](../../tests/phase0-gate-validator.test.ts)
  - [`docs/testing/2026-11-15-phase0-validator-fixture-headroom.md`](./2026-11-15-phase0-validator-fixture-headroom.md)

## Problem & Failing Controls (RED)

1. **Root cause:** [`scripts/test-encrypted-backup.sh`](../../scripts/test-encrypted-backup.sh#L270-L277) runs Linux `unit` with `TMPDIR=/tmp` on a fixed `size=16m` tmpfs alongside `node-compile-cache` and sibling test scratch. Previously, `createFixture()` recursively copied whole `docs/`, `AGENTS.md`, `README.md`, `migrations/`, `scripts/`, `src/`, and `tests/` trees per fixture call.
2. **Pre-fix combined failing CI control (`5cb57f7e26a1bf1045dfa33749447393bd7d9c59`):** Merging PR #22 (`cc5c723a774f2f291985c9bbd3a043b91343acc6`) and PR #23 (`46c0e6dc6e3827764e7c2992fab23535506c33a7`) onto `c2d8225d2a096e2d4f406c35f8ab170a6dad2f80` expanded full-repo fixture allocation to **716 files / 37 directories / 7,998,133 raw bytes (`9,596,928` bytes in 4 KiB pages + dir blocks)** before compile-cache use. Isolated GitHub `ci` (`validate`) run [`43700951962`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/43700951962) failed with **8 `ENOSPC` errors** (`tests/phase0-gate-validator.test.ts`, `125 passed | 1 failed | 11 skipped (137)` files, `2321 passed | 8 failed | 397 skipped (2726)` tests in `90.51s`), reproducing the same failure mode seen earlier at PR #22 `1fa4877` ([`43688890082`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/43688890082), [`43688896239`](https://github.com/thefastcyberdefense/fcd-support/actions/runs/43688896239)).
3. **Local TDD RED control:** Adding bounded exclusion assertions before updating `createFixture()` failed `1/10` (`9 passed | 1 failed` in `10.24s`) because `createFixture()` still copied `docs/PLAN.md`, `src/main.ts`, `tests/admin-app.test.ts`, and `tests/operations-scripts.test.ts`.

## Bounded Fixture Implementation (GREEN)

- **Derived validator dependency graph ([`tests/phase0-gate-validator.test.ts`](../../tests/phase0-gate-validator.test.ts#L63-L173)):**
  - `readValidatorInputs()` extracts `requiredEvidenceFiles`, `citedEvidenceFiles`, and `requiredSections` artifact paths directly from [`scripts/validate-phase0-gate.ts`](../../scripts/validate-phase0-gate.ts) alongside `AGENTS.md` and `docs/TODO.md`.
  - `collectValidatorDependencies(sourceRoot)` dynamically resolves every `` `(docs/...)` `` target referenced by `P0-003`..`P0-018` and `P0-GATE` rows of `docs/TODO.md` and every `` `path:line` `` source citation inside `citedEvidenceFiles`.
  - `resolveBoundedRelativePath()` and `copyBoundedDependency()` reject empty, absolute, escaping (`..`), or symlink paths, create real parent directories, and fail closed (`ENOENT`) via `lstat`/`copyFile` if any required target is missing—never creating placeholders.
- **Preserved and added tests ([`tests/phase0-gate-validator.test.ts`](../../tests/phase0-gate-validator.test.ts#L294-L488)):** All nine existing validator tests and assertions remain verbatim, plus three focused tests covering repository bounded-copy exactness (`< 60` files, excludes unrelated trees), dynamic tracker/citation discovery and missing-target `ENOENT` failures, and root-escape rejection (`12/12` passed in `1.67s`).

## Fixture Sizing Comparison

Sizing sums 4 KiB-aligned regular file allocations (`max(4096, ceil(bytes / 4096) * 4096)`) plus `4,096` bytes per unique directory inside the copied tree (excluding the single `4,096`-byte `mkdtemp` root directory itself):

| Tree Variant                                                  | Copied Files | Unique Dirs |   Raw Bytes | 4 KiB + Dirs Bytes |
| ------------------------------------------------------------- | -----------: | ----------: | ----------: | -----------------: |
| Full repo on `origin/main` (`c2d8225`)                        |          713 |          37 |   7,830,557 |          9,424,896 |
| Full repo on pre-fix combined (`5cb57f7`)                     |          716 |          37 |   7,998,133 |          9,596,928 |
| **Bounded follow-up (`tests/phase0-gate-validator.test.ts`)** |       **29** |      **16** | **550,349** |        **696,320** |

The bounded fixture keeps the required 29 files (including `AGENTS.md`, `README.md`, `docs/TODO.md`, Phase 0 evidence/review docs, and cited `migrations/`, `scripts/`, `src/`, `tests/` targets) at **`696,320` bytes (`~0.66 MiB`, `-92.7%` vs `5cb57f7`)**, freeing `~8.49 MiB` inside `/tmp` (`size=16m`) with `node-compile-cache` intact and zero changes to production code, validator policy, Docker mounts, tmpfs limits, dependencies, `docs/TODO.md`, or `docs/PROJECT_CONTEXT.md`.

## Follow-Up Verification Before Final Commit

| Check                                                                                          | Outcome                | Scope / Notes                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `npx vitest run tests/phase0-gate-validator.test.ts`                                           | **PASS** (`12 passed`) | 9 preserved negative/positive controls + 3 new tests (`1.67s`) |
| `npm run validate:phase0`                                                                      | **PASS**               | Exit `0` against repository `HEAD` dependencies                |
| `npm run format:check` & explicit `prettier --ignore-path .gitignore --check` on this Markdown | **PASS**               | Re-verified before final commit                                |
| `npm run lint && npm run typecheck && npm run build`                                           | **PASS**               | Strict TypeScript + ESLint + build cleanly zero-error          |
| `node scripts/verify-security-policy.ts`                                                       | **PASS**               | Secret & synthetic-fixture heuristic scan clean                |

Final-tree combined-candidate validation (PR #22 `cc5c723` + PR #23 `46c0e6d` + this final follow-up commit across isolated Linux `validate` CI with `16 MiB /tmp` and one solo four-worker Windows `npm test` run), immutable CI links, and rollback notes are recorded in the follow-up Draft PR handoff summary.

## Scope & Governance Boundaries

- `origin/main` (`c2d8225`), primary checkout (`J:\DevDrive\fcd-support`), PR #22 (`cc5c723`), PR #23 (`46c0e6d`), `docs/TODO.md`, `docs/PROJECT_CONTEXT.md`, and `P7-005`/`P7-GATE` blockers remain untouched and unmerged.
- Zero SSH, shared-server Docker, Meta, Manifest, tunnel, n8n, or account operations occurred.
