# Antigravity Phase 6 local closeout and Codex review results

## Immutable submission and scope

Antigravity submitted review branch `codex/agy-p6-local-closeout` through
[draft PR #1](https://github.com/thefastcyberdefense/fcd-support/pull/1).
The fetched base is `37a40f9e18b43228ac01ad5e39694b3273a2270e`; the submitted
head is `b802e3cbbcd093e0f2bef06097dacb3d5319fd24`.
All implementation and review corrections use the existing isolated worktree
`J:\DevDrive\fcd-support-agy-review`. The primary checkout and main branch
were unchanged during this review. The authenticated-account check passed.

Actual submitted commits, verified from fetched Git history:

1. `799d3b68f1dcfaafda610040dfdf183d94c37d14`: promotion metadata correction.
2. `6fe1267b2b99b12644d13339c1082dd2e64e585f`: Task 11 gap matrix.
3. `ff60ef78dd8e0c2f28e60e183d5eeffdb082e185`: Tasks 12–14 readiness matrix.
4. `b802e3cbbcd093e0f2bef06097dacb3d5319fd24`: submitted results artifact.

The original handoff contained incorrect full hashes for commits 2 and 3.
The original results also attributed the preserved server failure to mount
ordering and claimed a RED result that its counter fixture did not demonstrate.
Those claims are withdrawn. Mount instability is independently demonstrated;
the absent server job's exact failure point and SQL outcome remain unknown.

## Changed files and ownership

| Assignment                 | Files                                                                                                       | Result                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Promotion correction       | `src/operations/promotion-host.ts`, `scripts/operations-promotion-host.sh`                                  | Required terminal observations, strict validation, mount-order comparison and complete bind-inventory comparison                       |
| Production comparison port | `src/operations/promotion-mounts.ts`                                                                        | Shared pure canonicalizer used by the compiled validator and actual Docker projection probe; no new authority or host privilege        |
| Regression evidence        | `tests/promotion-host.test.ts`, `tests/promotion-host-script.test.ts`, `scripts/test-docker-projections.sh` | Deterministic permutations, real counter persistence, required observations, ordered execution arrays and actual production comparison |
| Rollback coverage          | `tests/operations-controller.test.ts`                                                                       | Direct non-ready rollback cases preserve phase and invoke no mutation primitives                                                       |
| Task 11 coverage           | `docs/testing/phase-6-task-11-gap-matrix.md`                                                                | Exact test citations, observed containment and explicitly unresolved authority/server proof                                            |
| Tasks 12–14 coverage       | `docs/testing/phase-6-tasks-12-14-integration-readiness.md`                                                 | Exact component coverage; deferred systemd/live-service work stays separate                                                            |
| Results                    | This document                                                                                               | Historical submission and independently executed correction evidence are distinguished                                                 |

## Independent review and RED/GREEN evidence

A fresh read-only reviewer examined all eight submitted files at the immutable
range above. It found seven important issues: unordered host-bind inventory,
a subshell-only regression counter, a copied Docker canonicalizer, unsupported
results/provenance claims, inaccurate matrix citations/contracts, invented
external gate requirements and unnecessary operator personal data in evidence.
Codex corrected these in one review fix pass; this is not the Task 15 whole-phase
review or P6-GATE approval.

- **Host bind inventory RED:** `npx vitest run tests/promotion-host.test.ts -t
'accepts reordered host bind inventory'` failed with `promotion_host_invalid`
  on the submitted comparison. **GREEN:** complete host-bind records are sorted
  without dropping fields or multiplicity. Repeated projected sources remain
  allowed; a changed entry count still refuses.
- **Fixture RED:** requiring distinct initial/terminal projections failed because
  the Bash counter increment vanished in command-substitution children.
  **GREEN:** a test-owned counter file persists both observations, and the test
  asserts two inspections and distinct payloads before cleanup.
- **Original-behavior RED:** temporarily restoring the original raw recheck with
  the corrected fixture failed `expected 1 to be +0`. Exact source bytes were
  restored in `finally`; the same focused test then passed. An initial diagnostic
  wrapper hit Windows output-decoding failure; the repeat used explicit UTF-8
  and verified the intended RED/GREEN result. This supplies no historical server
  failure-stage evidence.
- **Production Docker comparison:** the five local projection checks passed
  after `npm run build`; the promotion probe imports the compiled production
  canonicalizer, uses actual two-mount Docker output, reverses it deterministically,
  and checks changed mount fields, omission and duplicate refusal. It does not
  authorize a live host or replace the full-validator unit/native composition.
  The Linux-only stopped-job creation proof was explicitly skipped on Windows.
- **Rollback coverage:** four new cases invoke rollback itself in uncertain,
  draining, quiescent and switching phases. These cover existing refusal behavior;
  they are not claimed as failing-before-code fixes.

## Executed validation

| Candidate                                           | Command or evidence                                                                                                        | Observed result                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submitted branch                                    | `VITEST_MAX_WORKERS=4 npm run check`                                                                                       | Exit 0; 1,865 passed / 433 platform skips across 125 files; strict typecheck, lint, formatting, Phase 0 validation and build passed                 |
| Submitted exact head                                | GitHub PR workflows                                                                                                        | CI `40887853005`, PostgreSQL/native `40887852999`, CodeQL `40887852989`, private runtime `40887853166`: success                                     |
| Corrected candidate, before final additional guards | Focused promotion, shell and controller files                                                                              | Exit 0; 90 passed across three files                                                                                                                |
| Corrected candidate                                 | `npm run build` and `scripts/test-docker-projections.sh`                                                                   | Exit 0; five Docker projection checks, one explicit Linux-only skip                                                                                 |
| Corrected final candidate                           | `VITEST_MAX_WORKERS=4 npm run check`                                                                                       | Exit 0; 1,873 passed / 433 platform skips across 125 files; tests 256.28 seconds; static checks and build passed                                    |
| Corrected final candidate                           | `FCD_SYNTHETIC_TEST_PROJECT=fcd-support-test-agy-review bash scripts/test-encrypted-backup.sh grants`                      | Exit 0; 1,280 native tests / 55 files (400.24 seconds), then 139 PostgreSQL tests / one separate restore-only skip / 13 files (53.28 seconds)       |
| Corrected final candidate                           | Native real-Docker ownership, subnet/IPAM, confinement and cleanup proofs                                                  | Passed; dedicated project actors/networks/volumes and matching backup-harness actors/networks/volumes/image tags all zero after exact-owned cleanup |
| Corrected evidence                                  | TypeScript-AST matrix citation audit against each row’s named test files; shell syntax; targeted added-content secret scan | 84 exact test titles matched, zero citation mismatches; shell syntax passed; no high-confidence credential pattern and no operator email in results |
| Corrected commit                                    | Updated exact-source GitHub workflows                                                                                      | All four corrected-head PR workflows passed: CI 40902218674, CodeQL 40902218718, private runtime 40902218680, PostgreSQL/native 40902218850         |

Antigravity reported its own Windows checks and Docker projection run. It did
not provide an executed native/PostgreSQL lane in the submitted artifact. The
exact-head GitHub results above and Codex's explicit executions must not be
represented as Antigravity's local native execution. Corrected-head CI passed before integration. All four merged-source workflows
also passed for 70f8e70 (CI 40903959620, CodeQL 40903959344, private runtime
40903959355, PostgreSQL/native 40903959531).

An intermediate correction check stopped at three fixture lint errors (an unsafe
finally throw and two non-null assertions). They were corrected before the final
passing gate; no assertion, application timeout or policy was weakened.

## Acceptance and remaining work

- [x] Required terminal observations and all identity/capability/challenge checks remain.
- [x] Mount permutations and complete host-bind inventory permutations compare semantically.
- [x] Ordered command, entrypoint and execution-flag arrays remain ordered.
- [x] The regression genuinely exercises different initial and terminal observations.
- [x] Actual Docker comparison invokes production code rather than a copied algorithm.
- [x] Matrix citations and socket, backend-prefix and rollback contracts are corrected.
- [x] Unsupported historical RED/failure attribution, incorrect SHAs and operator personal data are removed from this artifact.
- [x] Final corrected-candidate local/native execution evidence and scoped cleanup are recorded.
- [x] Updated exact-source CI passes after the correction commit.
- [x] Review corrections were committed/pushed as ace6bab and integrated after validation as 70f8e70.
- [ ] Fresh synthetic server promotion, compatible rollback, remaining failure matrix and Task 15/P6-GATE remain open.

The submitted local work and PR correction performed no server/live-service
mutation, journal settlement or phase/gate completion. Codex subsequently ran
separate read-only server checks; their evidence is in the deployment runbook. Existing
uncertain scopes remain preserved. PostgreSQL remains authoritative; models
receive no tools. Only newly authored synthetic fixtures are used. Codex retains
server action records, later deployment and gate decisions. Installing systemd
units or enabling live services is not a prerequisite invented by these matrices.

A separate later raw-mount comparison in the PostgreSQL stop/remove guard was
then demonstrated through the actual unchanged template. The 70f8e70 proposal
was not deployed; its local unexecuted action drafts were withdrawn. See the
post-verification metadata-stability spec/plan and updated AGY handoff for the
next bounded correction. Passing this PR's gates does not override that blocker.
