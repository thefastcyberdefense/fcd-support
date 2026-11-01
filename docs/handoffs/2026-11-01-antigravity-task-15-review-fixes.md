# Antigravity next assignment: PR #3 acceptance-proof corrections

Start now under existing owner approval. Keep draft PR #3 and branch
`codex/agy-p6-failure-matrix` in `J:\DevDrive\fcd-support-agy-failure-matrix`.
First preserve any local changes, fetch/merge latest main and read:

- `docs/reviews/2026-11-01-pr-3-task-15-review.md`
- `docs/superpowers/plans/2026-11-01-phase-6-task-15-review-corrections.md`
- fresh AGENTS, TODO, PROJECT_CONTEXT and SYNTHETIC_FIXTURE_POLICY.

Codex reviewed `9a4fc61ddd80f8f36bdfc28db6da305968945f0e`. All four exact-head
workflows pass, but Task 15 is not accepted: the new tests do not yet establish
the approved filesystem, owning scheduler/catalog and older-snapshot proofs.
The linked plan provides the correction tasks and acceptance criteria.

- [ ] Real owning scheduler/preflight flock concurrency, actual PostgreSQL
      current-slot deduplication and bounded child reaping on failures.
- [ ] Actual EROFS from a dedicated correctly owned/mode-0700 read-only mount,
      writable control, archive preservation, exact cleanup and captured output.
- [ ] Explicit provider acceptance ahead of the older restored snapshot; one
      provider instance proves zero inherited sends and one eligible send,
      using a separate unfenced control fixture and preserving the restored
      fixture's active recovery hold across repeated runs.
- [ ] Correct Git provenance, citations, completion claims, final-source counts
      and Markdown formatting; retain useful existing assertions and CI step.
- [ ] Complete linked validation/cleanup, push PR #3, and return its final full
      SHA, four exact-head workflow links and revised results artifact.

Do not edit Codex's primary checkout/trackers/actions or touch the server,
other projects, old uncertain scopes, production, live providers or the tunnel.
Do not change recovery policy or begin Phase 7. Codex retains merge, the
whole-phase gate decision and final server handoff. No new per-detail owner
approval is required for these corrections.
