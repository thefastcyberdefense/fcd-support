# Antigravity Phase 6 CI runtime and observer results

## Immutable submission and scope

Antigravity executed Priority 0, Task 1, Task 2, and Task 3 from
`docs/handoffs/2026-10-29-antigravity-phase-6-ci-runtime.md` on review branch
`codex/agy-p6-ci-runtime-tests` in dedicated worktree
`J:\DevDrive\fcd-support-agy-runtime-tests`.
The primary checkout `J:\DevDrive\fcd-support` and `main` branch were completely
untouched.

- Base commit: `fe12574f77d6eb4cff65c3034843408663cf55a2`
- Verified ancestor: `70f8e7073d20bce0b54d84011e001a2bd5bb527f`
- Target review branch: `codex/agy-p6-ci-runtime-tests`
- Review commits on branch:
  1. `077f15d8f3597d078a3f96210b1225d72e5d1f21`: `feat(operations): canonicalize promotion static metadata mounts in multiline projection`
  2. `9fc575e2171b29bfccc3b42c4fc6fad8e7ab47d8`: `feat(operations): automate public synthetic recovery success path in ephemeral ci`
  3. `6f8486fa43b1ff7200e1a293077df0d47205a4d9`: `test(operations): expand hermetic observer runtime verification and edge cases`

## Changed files and ownership

| Assignment | Files | Description |
| --- | --- | --- |
| Priority 0: Static Metadata Stability | `scripts/operations-promotion-controller.sh` | Atomic multiline projection for `OPERATIONS_PROMOTION_STATIC_FORMAT` with `operations_promotion_static_canonical` sorting raw JSON mount lines while preserving multiplicity, Mode, and Driver |
| Priority 0: Scoped Docker Test | `scripts/test-docker-projections.sh` | Added production canonicalization check of `OPERATIONS_PROMOTION_STATIC_FORMAT` with deliberate permutation and negative controls |
| Priority 0: Regression Tests | `tests/operations-promotion-controller.test.ts`, `tests/promotion-static-metadata.test.ts` | Mount reordering fixture in controller tests; dedicated 10-case suite covering permutations, mutations, duplicates, and framing |
| Task 1: Ephemeral CI Recovery | `scripts/test-synthetic-runtime-deployment.sh` | Extended `--ephemeral-ci` mode to exercise public backup, checkpoint, isolated restore, promotion onto distinct identity, rollback, and owned cleanup |
| Task 1: Evidence Allowlist | `scripts/synthetic-host-evidence.sh` | Added recovery stages (`backup`, `checkpoint`, `restore`, `promote`, `rollback`, `cleanup`), refusal codes, and controller scripts to closed diagnostic reporter |
| Task 1: Orchestration Guards | `tests/runtime-host-script.test.ts`, `tests/synthetic-host-evidence.test.ts` | Guard tests for CI recovery assertions, physical identity distinctions, and failure reporting |
| Task 2: Observer Verification | `docs/operations/actions/2026-10-29-promotion-observer-test.py` | Expanded hermetic observer tests: fragmented streaming with CRLF, runtime guard refusal, duplicate challenge nonces, boolean field rejections, and missing actor checks |
| Task 3: Results Handoff | `docs/handoffs/2026-10-29-antigravity-phase-6-ci-runtime-results.md` | This results artifact |

## RED/GREEN evidence

- **Priority 0 mount ordering in promotion controller:**
  - **RED:** In `tests/operations-promotion-controller.test.ts`, adding a `'mount-order'` fault case under raw string comparison failed with `promotion_actor_refused` (`expected 1 to be +0`, exit code 1) because Docker inspect returned mounts in non-deterministic order.
  - **GREEN:** Applying the atomic multiline projection format and sorting complete mount records via `LC_ALL=C sort` in `operations_promotion_static_canonical` resolved the reproduction cleanly (exit code 0; all 38 tests passed).
  - **Actual Docker verification:** `scripts/test-docker-projections.sh` verified that inspecting a 2-mount container produces valid canonical facts, preserves full fields under deliberate reversal, and detects destination mutations and malformed framing (`docker_promotion_static_canonical_passed=true`).
  - **Unit suite:** `tests/promotion-static-metadata.test.ts` verified 10 cases: 3-mount permutations, 9 distinct field mutations (including Mode, Driver, Type, RW, ExtraField), duplicate preservation without sort `-u`, and framing error rejections.

- **Task 1 synthetic recovery diagnostics & guards:**
  - **RED:** In `tests/synthetic-host-evidence.test.ts`, running `stage=restore` before allowlist updates produced `synthetic_host_failed=unknown` and stripped `operations_restore_refused` and `operations-restore-controller.sh:71:previous=1`.
  - **GREEN:** Updating `scripts/synthetic-host-evidence.sh` to include recovery stages and scripts resolved the failure; all 4 tests passed.
  - **RED:** In `tests/runtime-host-script.test.ts`, asserting that `scripts/test-synthetic-runtime-deployment.sh` exercises the full recovery path failed before the harness extension was wired.
  - **GREEN:** Wiring stages `backup`, `checkpoint`, `restore`, `promote`, `rollback`, and `cleanup` with authoritative state assertions in `scripts/test-synthetic-runtime-deployment.sh` satisfied all 7 tests.

- **Task 2 observer verification expansion:**
  - 4 additional test methods authored in `docs/operations/actions/2026-10-29-promotion-observer-test.py`:
    - `test_runtime_fragmented_crlf_stream`: exercises the observe loop under chunked event/protocol delivery with CRLF line endings.
    - `test_runtime_guard_refusal_reaps_reader`: exercises the observe loop under mismatched inspect metadata, verifying reader termination and `guard_refused` emission.
    - `test_duplicate_challenge_nonces_rejected`: asserts `protocol_stage` rejects identical nonces across challenges as `protocol_invalid`.
    - `test_bind_job_rejects_missing_actor_and_boolean_types`: asserts `bind_job` rejects missing actors and non-string version/phase types.
  - All 32 active tests passed on Windows; 1 test skipped on Windows (`test_runtime_sighup_exits_through_cleanup`, documented Linux-only).

## Executed validation

| Candidate / Scope | Command or evidence | Observed result |
| --- | --- | --- |
| Shell syntax check | `bash -n` on all 4 modified scripts | Exit 0; no syntax errors |
| Actual Docker projections | `scripts/test-docker-projections.sh` | Exit 0; runtime, restore, drain, adoption, promotion mount, and promotion static canonical passed |
| Python observer test | `python docs/operations/actions/2026-10-29-promotion-observer-test.py` | Exit 0; 32 passed, 1 skipped (SIGHUP on Windows) in 1.133s |
| Static metadata suite | `npm test -- tests/promotion-static-metadata.test.ts` | Exit 0; 10 passed across all permutations and mutations |
| Promotion controller suite | `npm test -- tests/operations-promotion-controller.test.ts` | Exit 0; 38 passed in 72.77s |
| Runtime host & evidence tests | `npm test -- tests/runtime-host-script.test.ts tests/synthetic-host-evidence.test.ts` | Exit 0; 11 passed |
| Phase 0 gate validation | `npm run validate:phase0` | Exit 0; tracker, evidence, citations, and authority boundary valid |
| Code formatting check | `npm run format:check` | Exit 0; all matched files use Prettier code style |
| Code lint check | `npm run lint` | Exit 0; ESLint passed without warnings |
| TypeScript typecheck | `npm run typecheck` | Exit 0; `tsc --noEmit` clean |
| TypeScript build | `npm run build` | Exit 0; `tsc --project tsconfig.build.json` clean |
| Local Docker cleanup | `docker ps` and `docker volume ls` filter checks | Passed; zero leftover containers or volumes |

## Acceptance and boundary confirmations

- [x] Deterministic mount permutations pass capture and proof; raw fields, duplicate multiplicity, and ordered metadata are preserved.
- [x] Ephemeral Linux CI harness extended to exercise full public recovery success path on synthetic data (backup, checkpoint, restore, promote, rollback, cleanup).
- [x] Observer loop verified across fragmented UTF-8/CRLF streams, guard refusal, reader reaping, duplicate challenges, and strict types.
- [x] PostgreSQL remains authoritative state store; models receive no tools; no external connectivity or live credentials.
- [x] All older uncertain scopes (`6faff8b` and earlier) remain completely untouched and preserved.
- [x] Primary checkout `J:\DevDrive\fcd-support` and `main` branch are untouched.
- [x] Neither Task 11, Task 15, nor P6-GATE is marked complete; live server action is deferred to Codex.
