# Antigravity next task: finish PR #3 harness closeout

Start now under existing approval in the existing isolated
`codex/agy-p6-failure-matrix` branch. Keep PR #3 draft. Preserve local work,
fetch/merge latest main and read:

- `docs/reviews/2026-11-01-pr-3-correction-review.md`
- `docs/superpowers/plans/2026-11-01-phase-6-task-15-harness-closeout.md`
- fresh AGENTS, TODO, PROJECT_CONTEXT and SYNTHETIC_FIXTURE_POLICY.

Codex reviewed `b3831b07024e5c7b7e6fde121062fce07bf2a256`. Real EROFS,
owning preflight locking, real catalog assertions and the seeded older-snapshot
same-provider test are accepted as coverage. Preserve them. Three bounded
issues remain, with full acceptance details in the linked plan:

- [ ] Internally bounded barrier/exit waits and reaping, including silent child,
      premature exit and failed spawn. Prove cleanup before Vitest's outer
      timeout; the outer timeout alone does not enter the test's `finally`.
- [ ] Fresh owned RO volume admission, contained exact root initializer,
      collision/foreign-consumer refusal, and verified cleanup that fails the
      gate on leftovers. Follow the existing contained ownership-test pattern.
- [ ] Finish every gap-map citation/claim audit and correct the results record;
      do not retain nonexistent files/titles or unsupported transport claims.
- [ ] Genuine harness RED/GREEN, full final local/native/PG/network validation,
      scoped cleanup and all four final-head workflows. Report exact evidence.

Codex's full Windows check at the reviewed head had two 5,000 ms timeouts
(controller verify and lost-create-acknowledgement cases); both passed in an
unedited one-worker focused rerun. This is not a passing full gate. Preserve
that history and investigate recurrence before claiming final validation.

No SSH, server or other-project changes, old uncertain-scope work, live calls,
tunnel/production, recovery-policy changes, primary checkout/tracker/action
edits, main merge or Phase 7 work. Task 11 is already COMPLETE; Task 15 and
P6-GATE remain pending Codex acceptance. Return the revised PR #3, final full
SHA and updated results artifact; no new per-detail owner approval is needed.
