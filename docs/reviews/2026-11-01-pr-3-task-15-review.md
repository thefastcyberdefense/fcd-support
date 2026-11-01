# PR #3 Task 15 review

Date: 2026-11-01 (Asia/Dhaka).
Decision: **Changes required; retain draft PR #3. Task 15 is not complete.**

Reviewed base: `c6b7c01c8facd63fbd722dfcc0bb24ffddab5238`.
Reviewed head: `9a4fc61ddd80f8f36bdfc28db6da305968945f0e`.
PR: <https://github.com/thefastcyberdefense/fcd-support/pull/3>.
The seven-file diff changes tests, a test fixture, CI and evidence only. No
application behavior defect has been demonstrated by this review. The following
are missing acceptance proofs, not authorization for a recovery-policy change.

## Required corrections

1. **Important: exercise the owning scheduled-operation boundary.**
   `tests/systemd-contract.test.ts:488` writes its own lock acquisition and
   `:594` implements deduplication with a trace-file grep and a literal
   `not_due` response. It never calls `operations_scheduled_main`, the actual
   `operations_preflight` lock or a PostgreSQL catalog. A regression in those
   owning modules would not fail this test. Replace this simulation with real
   scheduler/preflight activations and real catalog slot deduplication. Keep
   the deterministic barrier, nonblocking refusal, no-job assertion and later
   successful activation. Bound and reap every child in failure/timeout paths;
   the present `finally` only removes the scratch directory.
2. **Important: prove an actual read-only filesystem failure.**
   `tests/backup.test.ts:286` changes directory mode to 0500, which fails the
   required 0700 admission check in `src/operations/backup.ts:94` before any
   backup write. The `:353` EROFS case injects a rejected publish promise.
   These are useful permission-admission and injected-error tests, respectively;
   neither establishes an actual read-only mount failure through the owner.
   Add a dedicated read-only mount with correct numeric ownership/mode, a real
   filesystem EROFS observation and a writable control. Preserve archive and
   exact cleanup assertions. The loops at `:319` and `:379` inspect argv/env,
   not captured output; prove output sanitization with captured emitted output
   and the closed error, without printing sensitive sentinels.
3. **Important: establish the older-snapshot/provider-acceptance case.**
   `tests/integration/postgres-outbound-flow.test.ts:840` seeds an accepted row
   followed by a pending row, then quarantines the same database. No provider
   acceptance after the pending row's snapshot is established. The zero-send
   spy at `:873` is replaced by a different provider at `:928` for the positive
   control. Add an explicit older-snapshot state whose provider-side synthetic
   acceptance ledger is ahead of PostgreSQL. Use the same provider instance
   and captured send counter for held and eligible-control runs.
   Prove exact persisted inherited states, no resend across repeated runs and
   one send for eligible work in a separate unfenced synthetic database fixture.
   Keep the restored fixture's recovery hold active and unchanged; do not insert
   review records to lift it, add hold clearing or introduce a resolver.
4. **Important: correct the completion evidence.**
   The results document's base SHA disagrees with Git, and its primary revision
   says `43d5517` instead of the verified `c6b7c01`. Its claim that grep reaches
   a catalog is false. Gap-map line 32 cites nonexistent signature/ingest files;
   actual stale-event coverage is in
   `tests/integration/postgres-receipt-store.test.ts:290`. Line 37 attributes
   revocation/connection closure to crypto-only `admin-auth.test.ts`; actual
   revocation assertions are in
   `tests/integration/postgres-admin-identity.test.ts:333`. ENOSPC is now at
   `tests/backup.test.ts:473`, not the cited old line. The gap map still
   describes three gaps as pending while the result checklist marks all
   complete. Audit every citation, distinguish
   permission admission/injection from actual filesystem proof, and report
   final-source commands and counts accurately. Both changed Markdown files
   fail forced Prettier checking. Do not mark Task 15 or the phase gate complete
   before independent acceptance review.

## Independent verification

Executed in the clean linked AGY worktree at the reviewed head:

- `VITEST_MAX_WORKERS=4 npx vitest run tests/backup.test.ts tests/systemd-contract.test.ts`:
  exit 0, **89 passed / 8 platform skips**, two files, **10.56 s**. Linux-only
  filesystem/flock assertions were not executed on this Windows authoring host.
- Five hermetic `python -B` suites, individually: observer **32 passed / one
  SIGHUP platform skip** (1.162 s); reboot **11 passed** (0.067 s); peer **11
  passed** (0.038 s); rollback **6 passed** (0.035 s); current runtime **5 passed**
  (0.245 s). Suites overlap; these are not distinct coverage totals.
- `git diff --check c6b7c01..9a4fc61`: exit 0.
- Forced `prettier --check --ignore-path .gitignore` on the two changed Markdown
  files: exit 1, both need formatting.

GitHub independently confirms four successful final-head PR workflows:
[CI](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41220007517),
[CodeQL](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41220007529),
[private runtime](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41220007527),
[PostgreSQL/native](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41220007563).
The reported earlier `39dc670` application tree matches final `9a4fc61`; the
later commit changes only the results document. Captured final-head job logs,
reduced to counts only, report PostgreSQL **621 passed / 52 skips**, 56 files,
158.73 s; native **1,295 passed**, 55 files, 345.33 s; grants **139 passed / one
restore-only skip**, 13 files, 39.57 s; restore units **251 passed**, 12 files,
43.90 s; two-cluster integration **47 passed**, two files, 20.23 s. Lanes overlap
and must not be summed. CI success does not repair the missing assertions above.

No full local/native/PostgreSQL gate was repeated during this focused review.
No SSH, server mutation, deployment, provider call, tunnel change or production
action occurred. AGY's branch and primary application files were not edited.
P6-004/005/006 remain IN PROGRESS; P6-GATE remains BLOCKED. The older actor-loss
incident remains open and outside AGY's assignment.

Follow-up:
`docs/superpowers/plans/2026-11-01-phase-6-task-15-review-corrections.md`.

A separate read-only reviewer independently confirmed the blocking findings and
then reviewed this correction plan/handoff. No Important or Critical issue
remains in the follow-up instructions. This accepts the correction assignment,
not PR #3 or the Phase 6 gate. The documentation-only update passes Phase 0
validation, forced Markdown formatting and diff checks.
