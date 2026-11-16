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

- **Derived validator dependency graph and containment enforcement ([`tests/phase0-gate-validator.test.ts`](../../tests/phase0-gate-validator.test.ts#L64-L241)):**
  - `readValidatorInputs()` extracts `requiredEvidenceFiles`, `citedEvidenceFiles`, and `requiredSections` artifact paths directly from [`scripts/validate-phase0-gate.ts`](../../scripts/validate-phase0-gate.ts) alongside `AGENTS.md` and `docs/TODO.md`.
  - `resolveBoundedRelativePath(sourceRoot, rawPath)` normalizes relative inputs and rejects empty paths, NUL bytes, Windows drive prefixes, absolute paths, and lexical root escapes (`..`).
  - `assertBoundedRegularFile(sourceRoot, relativePath)` verifies `sourceRoot` is a real non-symlink directory, checks `realpath` containment inside `sourceRoot`, walks segment-by-segment with `lstat` to reject symbolic links or non-directories on every ancestor segment, and refuses symbolic links, directories, and any non-regular file at the leaf (failing closed with `ENOENT` when missing).
  - `collectValidatorDependencies(sourceRoot)` validates `docs/TODO.md` and every discovered `citedEvidenceFiles` document through `assertBoundedRegularFile()` before calling `readFile`, then resolves every `` `(docs/...)` `` target referenced by `P0-003`..`P0-018` and `P0-GATE` rows of `docs/TODO.md` and every `` `path:line` `` source citation inside `citedEvidenceFiles`.
  - `copyBoundedDependency(sourceRoot, destinationRoot, relativePath)` and `createFixture(sourceRoot)` enforce `assertBoundedRegularFile()` (removing recursive `cp` directory expansion), create real parent directories, copy regular files only via `copyFile`, and settle all concurrent copies via `settleAllOrThrow()` (`Promise.allSettled`) so any rejection finishes before `afterEach` cleanup deletes the temporary directory.
- **Preserved and added tests ([`tests/phase0-gate-validator.test.ts`](../../tests/phase0-gate-validator.test.ts#L310-L680)):** All nine existing validator tests and assertions plus the three bounded-fixture headroom tests remain intact, joined by three regression tests covering ancestor-directory symlinks/junctions (including `docs/TODO.md`, cited evidence files, leaf dependencies, leaf junctions, and a symlinked `sourceRoot`), refusal of directory dependencies across both top-level and cited subtrees, and POSIX leaf-file symlink rejection (`test.skipIf(process.platform === 'win32')` on Windows where file symlinks require elevation, enforced natively on Linux).

## Fixture Sizing Comparison

Sizing sums 4 KiB-aligned regular file allocations (`max(4096, ceil(bytes / 4096) * 4096)`) plus `4,096` bytes per unique directory inside the copied tree (excluding the single `4,096`-byte `mkdtemp` root directory itself):

| Tree Variant                                                  | Copied Files | Unique Dirs |   Raw Bytes | 4 KiB + Dirs Bytes |
| ------------------------------------------------------------- | -----------: | ----------: | ----------: | -----------------: |
| Full repo on `origin/main` (`c2d8225`)                        |          713 |          37 |   7,830,557 |          9,424,896 |
| Full repo on pre-fix combined (`5cb57f7`)                     |          716 |          37 |   7,998,133 |          9,596,928 |
| **Bounded follow-up (`tests/phase0-gate-validator.test.ts`)** |       **29** |      **17** | **570,687** |        **716,800** |

The bounded fixture keeps the required 29 files (including `AGENTS.md`, `docs/TODO.md`, Phase 0 evidence/review docs, and cited `infra/`, `migrations/`, `scripts/`, `src/`, and `tests/` targets) at **`716,800` bytes (`~0.68 MiB`, `-92.5%` vs `5cb57f7`)**, freeing `~8.47 MiB` inside `/tmp` (`size=16m`) with `node-compile-cache` intact and zero changes to production code, validator policy, Docker mounts, tmpfs limits, dependencies, `docs/TODO.md`, or `docs/PROJECT_CONTEXT.md`.

## Follow-Up Verification Before Commit

| Check                                                                                          | Scope / Notes                                                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npx vitest run tests/phase0-gate-validator.test.ts` (Windows host)                            | 9 preserved controls + 3 headroom tests + 3 containment/directory-refusal regression tests |
| `bash scripts/test-encrypted-backup.sh unit` (Linux container, unchanged `16 MiB /tmp`)        | Executes full unit suite including POSIX leaf-file-symlink test                            |
| `npm run validate:phase0`                                                                      | Exit `0` against repository `HEAD` dependencies                                            |
| `npm run format:check` & explicit `prettier --ignore-path .gitignore --check` on this Markdown | Verified on final committed tree                                                           |
| `npm run lint && npm run typecheck && npm run build`                                           | Strict TypeScript + ESLint + production build                                              |
| `npm audit --omit=dev --audit-level=high` & `node scripts/verify-security-policy.ts`           | Production dependency audit + secret/synthetic-fixture heuristic scan                      |

Exact pass counts, container timings, immutable CI links, combined-candidate validation (integrating this headroom fix before combining PR #22 `cc5c723` and PR #23 `46c0e6d`), and rollback notes are recorded in the Draft PR handoff summaries.

## Scope & Governance Boundaries

- `origin/main` (`c2d8225`), primary checkout (`J:\DevDrive\fcd-support`), PR #22 (`cc5c723`), PR #23 (`46c0e6d`), `docs/TODO.md`, `docs/PROJECT_CONTEXT.md`, and `P7-005`/`P7-GATE` blockers remain untouched and unmerged.
- Zero SSH, shared-server Docker, Meta, Manifest, tunnel, n8n, or account operations occurred.
