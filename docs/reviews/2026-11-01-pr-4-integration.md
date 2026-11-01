# PR #4 dependency integration review

Date: 2026-11-01 (Asia/Dhaka).
Decision: **Accepted and squash-merged as
`c74b6f4314e17fe707ba5e3f02a183d1ebe9b9fd`.** The complete merged tree equals
validated `9f76455be443a527ce58725fa574e7324631fd4d`.
PR: <https://github.com/thefastcyberdefense/fcd-support/pull/4>.

## Compatibility decision and limits

The exact overrides apply within `node-pg-migrate`'s subtree: glob `14.0.3` and
minimatch `11.0.3`. The production tree no longer contains the reported affected
glob/minimatch versions. The remaining minimatch `10.2.6` lock entry is dev-only.
The associated matcher, path-scurry and cache changes belong to that dependency
chain; no Node floor, application policy or migration authority was changed.

This is a project-reviewed override **outside the parent's declared glob
`~13.0.0` range**, accepted under the owner's delegated review authority. It is
not upstream endorsement or a guarantee of every possible library API. Primary
npm metadata independently confirms latest stable node-pg-migrate remains
`9.0.0`; both that version and `10.0.0-alpha.7` declare glob `~13.0.0`.
The selected dependencies' declared engines include the approved Node 24 line.

The repository migration caller still uses a fixed directory and no glob/
AbortSignal opt-in. Package presence did not establish public exploitability.
The override removes the affected production dependency copies while preserving
the inspected caller and passing the bounded compatibility checks below.

## Independent validation on the submitted source

- `npm ci --ignore-scripts`: exit 0; reproducible locked installation without
  lifecycle scripts.
- `VITEST_MAX_WORKERS=4 npm run check`: exit 0, **1,952 passed / 438 platform
  skips**, 131 files, **261.62 s**. Phase 0, formatting, lint, strict type checking
  and build all pass.
- The real installed `getMigrationFilePaths` API with `useGlob:false` and
  `useGlob:true` returns exactly the same expected **16** repository migration
  files. This independent host check used **Node 24.19.0**; pinned-container
  migration/restore compatibility is supported by the workflows below.
- Production `npm audit --omit=dev --json`: exit 0, all severity counts and total
  **zero**. The dev-inclusive install reports **11 moderate advisories**; this
  runtime-scoped change does not resolve or dismiss development-tooling findings.
- All four quoted historical Git references in the supplied results record
  resolve to actual commit objects. `git diff --check` passes. Its forced
  Markdown formatting and minor wording/skip-label issues are corrected in the
  documentation follow-up, without changing the tested dependency tree.

All four exact submitted-source workflows pass:
[CI](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41324888931),
[CodeQL](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41324888940),
[PostgreSQL/native](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41324888969),
[private runtime](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41324888966).
Captured job logs, reduced to safe counts, establish:

| Lane                         | Result                             | Files | Duration |
| ---------------------------- | ---------------------------------- | ----- | -------- |
| Linux CI units               | 2,020 passed / 370 lane skips      | 131   | 80.11 s  |
| Native operations            | 1,298 passed                       | 55    | 489.37 s |
| Full PostgreSQL              | 621 passed / 52 lane skips         | 56    | 97.78 s  |
| Grants PostgreSQL            | 139 passed / one restore-only skip | 13    | 58.35 s  |
| Restore units                | 252 passed                         | 12    | 62.08 s  |
| Real two-cluster integration | 47 passed                          | 2     | 25.72 s  |

These lanes overlap and are not summed. The CI workflow also passes real Docker
projections and the five hermetic Python suites separately: observer **33**
(0.449 s), reboot **11** (0.012 s), peer **11** (0.010 s), rollback **6** (0.007 s),
current runtime **5** (0.157 s). The Windows observer skip is SIGHUP, not symlink.
Both fresh/precreated private-runtime modes pass. No new local Docker/native/
PostgreSQL run is claimed for this review; those lane results come from CI.

A separate read-only reviewer found no Important/Critical source issue and
independently reproduced the 16-file discovery comparison. Minor evidence
corrections preserve the audit/runtime scope and bounded compatibility limits.
The final independent documentation review also passes with no Important or
Critical findings; it confirms the evidence-pack assignment is unblocked while
P6-GATE and Task 16 remain open.

## Next boundary

The runtime dependency correction is accepted. GitHub alert closure is a
separate observation; a clean production audit alone does not prove it or clear
dev-only findings. Final gate evidence must retain that distinction.
Read-only GitHub REST inspection after merge observed **#42 fixed (runtime)**
and **#43 open (development)**. No manual dismissal was made.

AGY can now execute
`docs/handoffs/2026-11-01-antigravity-phase-6-evidence-pack.md` on a fresh branch
from synchronized main. No further dependency-entry approval is needed.
Task 15's final evidence pack, P6-GATE and Task 16 remain open. The last recorded
server deployment is application `67a4a4b`; no patched-server deployment is
claimed. Task 16 must verify and deploy the accepted dependency artifacts under
its exact reviewed action scope. No SSH, server, live provider, Meta, tunnel,
production, old-journal or recovery-hold action ran during this review.
