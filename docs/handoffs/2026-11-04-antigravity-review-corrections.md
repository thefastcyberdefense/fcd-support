# AGY: correct PRs 9–11 and retain promotion evidence

Date: 2026-11-04 (Asia/Dhaka).
Authoritative review: `../reviews/2026-11-04-pr-9-10-11-review.md`.
Keep all three PRs draft. Codex owns acceptance/merge, runtime correction,
shared-server diagnosis/disposition and deployment. No SSH, shared-server Docker,
live provider/Manifest/Meta/n8n, account resets or host/daemon restart is delegated.

Read the review and original priorities, AGENTS, tracker/context and fixture
policy. Use the existing isolated branches; preserve primary main. Incorporate
fresh main without discarding any work. Do not combine these PRs or rewrite
historical failures as successes.

## A. PR #9: complete the real-role regression proof first

- [ ] Retain the five exact column-scoped grants. Do not expand them, change
      runtime credentials or bypass privacy eligibility.
- [ ] Make all three SQL list and all three authenticated HTTP RED cases
      independent so the first failure cannot suppress remaining reproductions.
      Demonstrate base failures and corrected GREEN results.
- [ ] Add actual retention purge boundary, expired observation and configurable
      evaluation-time cases using the restricted admin login, including HTTP.
- [ ] Add duplicate observations and linked identities belonging to fewer than
      the required distinct-person count; prove aggregate suppression despite
      enough occurrences. Preserve a valid distinct-person positive control.
- [ ] Add missing UPDATE/DELETE denial checks for source identities/events/
      privacy requests, escalation UPDATE, and individual sensitive receipt
      column read denials. Retain existing authentication/RBAC/CSRF regressions.
- [ ] Correct unsupported results claims and record exact head/lane evidence.
      Force-format the results document. Run native PostgreSQL, appropriate full
      source checks and final-head CI; commit/push to PR #9, retaining draft.

Acceptance: all required cases execute independently and fail for the intended
reason before the source fix; restricted-role SQL/HTTP is green afterward;
privacy/retention/distinct-person and negative privileges pass. No new authority
or live rollout. Codex already independently verified 58 passed / 1 skipped at
the submitted head; that does not cover the missing cases.

## B. PR #10: correct the observer and exercise the owning boundary

- [ ] Replace the false previous-status/hardcoded-line log-failure inference.
      Test the exact trace entrypoint and actual lifecycle path with canonical
      successful logs and actual nonzero log reads. Success must never emit
      log_read_failed; failure must remain distinguishable from empty output.
      Preserve existing acknowledgement, exit and uncertainty rules.
- [ ] Select health actors by exact operation parent/service ownership, not
      the runtime's Compose-project label. Verify absence before and after
      every invocation, including the final iteration. Test an owned leftover
      refusal and preservation of an unrelated actor.
- [ ] Prove PostgreSQL health persistence for each positive stress iteration
      using closed outcome/count assertions. A valid dependency_unavailable
      acknowledgement must remain a safe runtime result but cannot be recorded
      as a successful persistence lane. No raw rows or identifiers in output.
- [ ] Replace the test-local mocked loop/break claim with owning-harness or
      scheduler tests: inject uncertainty, verify zero later invocations,
      preserve its journal and avoid clearing/retry. Use the actual health path
      and new trace for empty/malformed/multiline/log-unavailable cases.
- [ ] Describe the framing test accurately: ten independent held-open streams,
      not ten frames on one persistent stream. Record behavioral RED evidence;
      a lint error is not a failing behavior test.
- [ ] Add exact source/immutable CI links and separate fresh/precreated,
      health-stress/private-runtime outcomes. Preserve the promotion failures
      listed in the review. Run final-source checks and both full runtime and
      stress lanes; do not claim all workflows green from stress subjobs alone.
- [ ] Force-format results and commit/push the corrected PR #10, still draft.

Acceptance: diagnostics classify the real operation correctly; actor guards
detect the proper owned scope; positive runs prove persistence; uncertainty
stops actual harness execution with evidence retained; final CI is green or
each unresolved failure is precisely reported for Codex disposition.

## C. PR #11: source-backed readiness corrections

- [ ] Map every current AC-01 through AC-36 individually. Supply actual proof,
      missing current proof or justified local-only/deferred applicability,
      dependencies, owner and exact action approval boundary for each.
- [ ] Correct P6-GATE to its recorded COMPLETE state and distinguish the later
      health hold/dashboard deployment dependency from historical closeout.
- [ ] Record implemented outbound v25.0 separately from historical v26 webhook
      samples; retain the reviewed upgrade/support-window preflight procedure.
- [ ] Replace invented Manifest fields, fixed timeout and provider order with
      approved configurable bounds, one application request, Manifest-managed
      fallback, omitted tool fields, real network attachment and attributable
      recording deletion/retention verification.
- [ ] Keep live n8n connection optional under separate P8-005 authority.
- [ ] Remove dirty-power-loss instructions and blanket zero-uncertainty claims.
      Preserve other server projects and historical uncertainty. Full-host
      restart remains a separate operational decision, not this assignment.
- [ ] Use actual durable-intent/delivery_unknown guarantees rather than claiming
      Meta provider idempotency. Audit every source/test reference; a narrow
      correction of an inherited broken acceptance-matrix citation is allowed.
- [ ] Force-format both documents, validate Phase 0, check references/links and
      secret patterns. Correct the results record; commit/push PR #11, draft.

Acceptance: complete and accurate current-source matrix, preserved historical
proof and authority boundaries, no invented configuration or new phase IDs,
valid citations and explicit formatting checks. No live item is marked passed.

## Additional bounded work: promotion failure diagnosis

After A–C are submitted, AGY can prepare a separate evidence-only draft PR on
`codex/agy-promotion-failure-diagnosis` from fresh main. Compare the immutable
promotion failures in the review, including the stress job that passed all ten
health iterations before failing promotion. Use only disposable CI or local
synthetic fixtures. Gather closed phase/outcome evidence and, if possible, a
deterministic failing reproduction. Do not add production controller fixes,
relax acknowledgement/preservation, infer SQL completion, settle an uncertain
scope or blindly rerun it. Codex will evaluate and implement any runtime fix.
Report a non-reproduction as such; do not claim that a later passing run erased
the failure. Keep this work separate from the three correction branches.

## Final handoff

- [ ] Report final base/head for each branch, corrected checklist, RED/GREEN
      commands, exact native/local counts with skips and immutable workflow links.
- [ ] Retain all failed observations and distinguish fresh/precreated lanes.
- [ ] Confirm no primary-checkout or shared-server mutation and no secret values.
- [ ] Keep PRs draft; send Codex the results. No phase/gate or deployment authority
      is delegated by this checklist.
