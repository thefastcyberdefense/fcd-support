# Independent AGY follow-up review

Date: 2026-11-10 (Asia/Dhaka). Base: `88de2eeb693c08559e57295aa6ca8d1cd27bd104`.

## Submission and verified CI

GitHub metadata and complete check rollups confirm the submitted heads below,
all still draft during inspection, each with 18 completed successful checks
including aggregate CodeQL and push checks. Five applicable PR workflows pass
on each head; the UI/SEO source scaffolds are not rendered-browser certification.

| PR | Exact submitted head | CI / native / runtime workflow runs |
| --- | --- | --- |
| 18 | e7c44a24497e8be994f1e64b4e8c61fe4ebf5bc4 | 42759657311 / 42759657566 / 42759657262 |
| 19 | 22b437788e57769d6a038afa59a89a486424cf98 | 42773203025 / 42773203314 / 42773203091 |
| 20 | ac7c17d23f25fc8bfa2a8c8f92140f6e9f8a6bd9 | 42765418989 / 42765418965 / 42765418749 |

Independent read-only reviewers assessed each patch. Passing checks do not
replace the scope, ownership, deadline or evidence review below.

## PR 18: corrections required, retain draft

- **P2, total cleanup budget:** `tests/helpers/process-lifecycle.ts:438-453`
  spends a full Windows tree-termination allowance and then the same full
  allowance waiting for closure, in both phases. The default 3,500 ms execution
  plus twice each 500 ms phase can consume approximately 5,500 ms, excluding
  setup/fixture removal, beyond the unchanged 5,000 ms test contract. Use shared
  absolute phase/overall deadlines and remaining time, including helper calls.
- **P2, completed parent leaves descendants:** the early return at line 435
  accepts an exited Windows root with closed stdio before tree cleanup. A
  hermetic owned Bash/background-child probe returned success while the child
  remained alive; its owned child was explicitly terminated afterward. Capture
  ownership while it is available and prove closed-stdio descendants are reaped.
  Numeric probes did not establish any unrelated sibling-kill defect; none is
  claimed here.

The existing owning-harness assertions remain present. Independent four-worker
focused verification passes **149 tests / 8 platform skips**, six files,
**66.62 seconds** (whole command 67.93 seconds). That success does not cover the
two missing failure paths. Exact base/source provenance and the original
unreproduced historical load trigger must remain explicit.

## PR 19: corrections required, retain draft

- **P1, collision preservation:** `scripts/test-health-stdio-docker.sh:61-80`
  removes actors selected by prospective scope labels. The EXIT trap at line
  148 is installed before precreation collision checks at lines 161-166. A
  refusal can therefore remove pre-existing matching actors/network/volumes.
  An actual-function hermetic Docker-port control confirmed collision refusal
  followed by removal of the pre-existing actor. Keep a creation/identity ledger;
  never adopt collided resources as cleanup targets.
- **P2, durable journal proof:** lines 329-338 replace every production journal
  helper, including no-op synchronization and incomplete printf records. The
  unit suite repeats this substitution at lines 527-534. These tests do not
  prove the actual durable uncertainty boundary. Retain actual journal helpers
  in the native fixture and require a fresh controller process to refuse replay
  without Docker calls or state mutation.
- **P2, real TRACE-off comparison:** lines 313-317 toggle diagnostics, but line
  466 always sources the TRACE entry installing functrace/DEBUG. Unit tests
  likewise always inject it. Compare real tracing disabled against real tracing
  enabled, preserving result, persistence and lifecycle equivalence.
- **P2, closed failure publication:** line 143 accepts arbitrary lexical stderr
  strings rather than known diagnostic tokens. Error reporting must use a
  closed enum and bounded numeric fields. Add authored sentinel controls over
  the complete ERR/EXIT output path; never publish captured bodies.

Built health execution, actual PostgreSQL assertions, held-open writer,
log-driver pairing and narrow dropped-output sensitivity are useful coverage.
The omitted-newline negative port is deliberate fault injection, not a separate
finding. Independent build passes and the 13 local regression tests pass in
**17.70 seconds** (whole test command 19.03 seconds). No local Docker or database
run was performed during this review. Historical attached-output loss remains
unreproduced; the new coverage must not be labeled a product RED.

## PR 20: no blocking patch finding

Independent graph comparison confirms all **95 production entries unchanged**,
including paths, integrity, dependency fields, scoped overrides and nested
minimatch 11.0.3. All 27 changed non-root entries are development-only. Official
npm metadata confirms the selected ESLint and parser engine/peer ranges support
the pinned Node/TypeScript line. Production-only audit reports zero findings.
The strict lint configuration, scripts, Node/npm pins and production graph are
unchanged. The results document's eight-file follow-up wording understates the
ten distinct paths it lists; this is a documentation correction, not acceptance
of a future parser/source upgrade. Independent `VITEST_MAX_WORKERS=4 npm run check` on exact ac7c17d passes
Phase 0, formatting, strict lint, typecheck, build and **2,212 tests / 461 skips**,
135 files, **236.68 seconds** (whole command 284.32 seconds). Exact-head Linux
CI 42765418989 passes **2,280 / 393 skips** in 84.11 seconds; counts are not
summed. All 18 check-rollup entries pass, including aggregate CodeQL
129661232655. Official registry metadata and a separate production-only audit
were independently checked. No dependency alert was dismissed or changed.

PR #20 is accepted as merge `c2491333086ab5b7ab0f56033114b535b6bed5af`,
with expected submitted head ac7c17d. Primary main fast-forwards. Both tested
source and merge trees equal `1103d6a2dc481e7f2526eae929ecb3049b71116b`.
The eight-versus-ten path wording is corrected in the documentation closeout;
no implementation or configuration change is included in that correction.

## Boundaries and follow-up

No SSH, shared-server Docker/systemd, tunnel, provider, Meta, Manifest, n8n,
ClickUp, account or alert change occurred. The deployed uncertain health job
and dashboard rollout remain Codex-owned and held. Synthetic CI does not settle
that job. PRs 18 and 19 receive separate bounded correction checklists; AGY must
preserve main, current evidence and production controllers.

## AGY correction assignments

- [PR 18 deadline and descendant corrections](../handoffs/2026-11-10-antigravity-pr-18-review-fixes.md).
- [PR 19 contained health regression corrections](../handoffs/2026-11-10-antigravity-pr-19-review-fixes.md).

Each assignment requires RED controls, exact final-source validation, updated
immutable CI evidence and rollback, while preserving the existing draft PR.
They may run independently in their existing isolated worktrees. No new
production module or server recovery authority is delegated.

## Documentation closeout validation

Primary dependencies are synchronized with the accepted lockfile using
`npm ci --ignore-scripts --no-audit` (exit 0). Phase 0, repository formatting,
strict lint, typecheck, build, production-only audit and staged whitespace checks
pass. The heuristic fixture/secret pattern scanner passes on 736 tracked files,
including all new handoffs. Local PR structure checking explicitly SKIPs without
GITHUB_EVENT_PATH; actual final-head PR checks passed in the recorded workflows.
No new full implementation test result is attributed to these documentation
changes. All review and handoff files are committed/pushed with the tracker.
