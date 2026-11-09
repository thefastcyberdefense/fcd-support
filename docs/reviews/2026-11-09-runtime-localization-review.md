# Independent runtime and governance follow-up

Date: 2026-11-09 (Asia/Dhaka). This review continues the approved Phase 6
corrective work. No shared-server, live-provider, tunnel or account action occurred.

## Accepted observations, retained uncertainty

AGY's actual PR #10 documentation head is
`e781163adac4f0ccc89dedae42639224f2b0b752`; the submitted expanded SHA beginning
`e781163464` is not the Git-generated head. Independent execution on the actual
head passed 168 focused tests / 0 skips in 14.54 seconds. The historical empty
log trace establishes its control-flow boundary; zero command statuses were
inferred from successful branches rather than independently measured fields.
The portable fixtures do not establish SQL settlement or durable journal writes.
Codex corrected these evidence qualifications in the PR branch.

AGY implementation run 42554661939 and later documentation-head run 42555955045
are different source checkpoints. At the later head, fresh ordinary and stress
lanes pass; both precreated lanes refuse promotion with generic
`samples.stability`. Passing health iterations do not settle the historic empty
log cause or the held shared-server job.

## Direct corrections

PR #13 source `105017cea07e05718fb23e307af69caedc6b0ea0` masks Markdown
comments without joining evidence fragments and treats an unterminated comment
as non-content. Two regression controls first failed; all 39 governance tests
then passed in 0.830 seconds. Lint, strict typecheck and build passed. Independent
review found no important actionable regression.

The previous f0c27ad workflow summaries were green while aggregate CodeQL check
128447342906 failed one high-severity query. The correction preserves the query
and scanner; aggregate CodeQL check 129201420460 now succeeds. This is not an
alert dismissal. PR #13 runtime run 42629296289 still fails precreated promotion
(job 129201118404); fresh succeeds. It remains draft and unmerged.

PR #10 source `fe3a66b9e411bb4e16815172809c6996875cfbac` adds 325 finite,
schema-owned stability refusal paths. Complete equality and all existing
validation checks remain authoritative. No arbitrary keys, values, identifiers
or paths enter diagnostics. All producer codes round-trip through production
and synthetic publication allowlists. Independent review found no important
issue; the full Windows gate passed 2,125 tests / 454 platform skips in
271.12 seconds, including Phase 0, formatting, lint, typecheck and build.

Its PR runtime run 42632398538 passes three full recovery lanes; fresh stress
job 129211729484 refuses at health-2 with an empty acknowledgement. CI
42632398682, CodeQL 42632398813 and PostgreSQL/native 42632398445 pass.
Its separate push runtime run 42632385517, fresh stress job 129211696113,
records the first precise promotion refusal:
`samples.stability.before_after.job.healthy`. This identifies a changed field,
not its values, direction or historical cause. No validator was weakened and
no uncertain scope was replayed to seek a green result.

The attached-health capture correction is committed/pushed as
`58497e48250e712528d3d54d767ba4480cf4b659`. Its full local gate passes 2,141
tests / 461 platform skips in 277.86 seconds. The networkless local native
lifecycle harness passes 38 / 0 skips in 33.47 seconds. Phase 0, formatting,
lint, strict typecheck and build pass; independent review found no important
lifecycle issue. The correction rejects NUL, oversized, empty, malformed and
nonzero attached frames without daemon-log fallback or replay.

Fresh source CI 42641308234, CodeQL 42641308302 and PostgreSQL/native
42641308114 pass. Runtime 42641308111 fails all four lanes at health-1 with
empty attached acknowledgement. This source is not accepted as a reliability
fix merely because local checks pass.

The subsequent bounded readiness and preserved-stdin correction is pushed as
`94c03d62029a6bdc606f72fb81967af685ee8571`. It observes exact owned running
promotion identity/command/health before snapshots, only waits on starting,
shrinks the existing configured timeout and rechecks journal/context afterward.
All snapshot equality remains authoritative. Framed stdin stays open/paused,
with real stdin unreferenced for natural exit; input failure still destroys it.
The reader's local Docker baseline did not reproduce output loss, so this is a
transport-contract correction and the CI/historical cause remains unproven.

Final full local `VITEST_MAX_WORKERS=2 npm run check` passes 2,152 tests / 461
platform skips across 134 files in 284.57 seconds, plus Phase 0, formatting,
lint, strict typecheck and build. Eight focused suites pass 319 / 0 skips
(27.26 seconds); local native promotion-wrapper tests pass 26 / 0 skips
(1.16 seconds). The actual corrected reader also passes a fresh exactly owned
networkless, non-root, read-only, resource-limited Docker proof with daemon
logging disabled, canonical attached output, wait 0 and exact cleanup.
Independent read-only review found no important issue.

The in-development full run's six failures are retained: five old TRACE ports
and the initial pause-only natural-exit timeout. The initial unsupported
multi-file state harness invocation refused before resource creation; no
allowlist was weakened. The final gate ran after these corrections.

Runtime CI 42645223225, ordinary CI 42645223209 and PostgreSQL/native
42645222782 were pending at the initial publication checkpoint; CodeQL
42645223115 had succeeded. Final outcome disposition follows below. The private test server
remains deployed at its previously recorded 24e5667 revision; source fixes are
not a server rollout. Dashboard grant fixes remain undeployed under the health
hold. No incident settlement or new gate PASS is claimed.

## Parallel AGY work

The next bounded task is
[`2026-11-09-antigravity-windows-harness-bounds.md`](../handoffs/2026-11-09-antigravity-windows-harness-bounds.md).
A separate follow-up checklist is
[`2026-11-09-antigravity-health-stdio-contract.md`](../handoffs/2026-11-09-antigravity-health-stdio-contract.md):
real built health-process/PostgreSQL/attached-stdio regression in an isolated
stacked draft branch (or fresh accepted main). No production controllers or
shared-server authority are delegated.

The Windows task preserves 5,000 ms tests, strengthens child deadline/reaping behavior, uses
hermetic fake external ports and requires exact RED/GREEN evidence in a fresh
branch/draft PR. Codex retains runtime acceptance, current CI diagnosis,
shared-server disposition and dashboard rollout.
