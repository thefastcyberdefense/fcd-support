# Phase 4 Reply-Decision Boundary Evidence

Date: 2026-09-12 (Asia/Dhaka)

## Scope

This checkpoint completes approved Phase 4 plan Task 12 and P4-003. It joins
the fail-closed sensitive-data gate and FAQ-first resolver to PostgreSQL reply
draft, escalation, and knowledge-gap state while preserving every Phase 3
guard. It creates no outbound message and performs no model or provider call.

## Implemented controls

- Only an applied customer event can enter the decision boundary. Exact replay
  is idempotent, conflicting material fails closed, and concurrent persistence
  serializes to one outcome.
- Sensitive inspection runs before FAQ resolution. A blocked inspection stores
  only the reviewed deterministic safe response and one linked, closed-reason
  escalation. FAQ and model paths are not consulted.
- A strong FAQ match stores the exact currently effective, approved bilingual
  answer and its controlled item/version provenance. Publication and review
  timing are revalidated transactionally before the draft is created.
- FAQ ambiguity or miss stores one content-minimized, value-free observation
  and returns `model_required` for the later boundary. No model is present in
  this checkpoint, and no customer reply is sent.
- Human pause, open privacy workflow, deletion tombstone/pseudonymization,
  retention expiry, and prior content erasure are checked at claim and again
  under row locks immediately before persistence. A newly effective guard wins.
- Open active-client artifacts use the next required annual review boundary.
  The authoritative conversation lifecycle still controls erasure, including
  when later reclassification makes a stored artifact deadline stale.
- Verified deletion, restore-gate erasure, and retention clearing now erase
  ready reply text and customer-derived gap summaries atomically. PostgreSQL
  remains authoritative.
- Access export schema `fcd-support.access.v2` adds allowlisted, subject-scoped
  reply-draft, knowledge-gap, and escalation records. Draft text passes the
  existing export redactor; unrelated subjects remain excluded.

## Test-first and validation evidence

- Initial unit execution failed because the reply-decision service did not
  exist. After implementation, 10 focused unit tests passed for ordering,
  blocked/no-FAQ behavior, exact FAQ persistence, gap outcomes, terminal claim
  outcomes, guard races, and input rejection.
- Initial PostgreSQL execution failed because the reply-draft store did not
  exist. Exact replay, conflict, concurrency, FAQ provenance, safe escalation,
  both gap kinds, and Phase 3 guard cases then passed.
- Self-review added failing-first regressions for source text erased after
  claim, open active-client retention, and a stale later artifact deadline.
  The observed failures were respectively an incorrect conflict, unavailable
  retention deadline, and retained reply content. All pass after correction.
- Human-pause and privacy-race coverage invokes the actual conversation-event
  processor and privacy-rights service rather than directly setting those
  guards.
- Focused reply-store and retention suites: 21 tests across 2 files passed.
- `npm run check`: Phase 0 validator, formatting, lint, strict type checking,
  build, and 378 unit tests across 32 files passed.
- Complete guarded PostgreSQL suite: 316 tests across 23 files passed.
- `git diff --check` and the repository secret-pattern scan passed before the
  checkpoint commit.

All fixtures are conspicuously synthetic and non-operational. No credential,
token, customer data, raw external message, external identity, or secret value
is included in this evidence.

## Deliberate non-claims

- No browser, Manifest, model, provider, Meta, n8n, tunnel, SSH, deployment,
  public-ingress, or production test was run for Task 12.
- This checkpoint persists internal decisions only. P4-004 and P4-005 own the
  tool-free Manifest boundary, configurable limits, timeout/failure behavior,
  and final model decision integration.
