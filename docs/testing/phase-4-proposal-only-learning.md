# Phase 4 Proposal-Only Learning Evidence

Date: 2026-09-11 (Asia/Dhaka)

## Scope

This checkpoint completes approved Phase 4 plan Task 9 and P4-002 locally. It
adds content-minimized support-gap observations, aggregate insights, bounded
owner-question digests, authenticated dashboard answers, and draft-only
knowledge proposals. It does not perform model inference, contact a provider,
send a message, deploy a service, or change external infrastructure.

## Implemented controls

- Gap observations require an applied internal customer-message event. The
  input contract rejects external identities, payloads, raw-message fields,
  tool fields, arbitrary summaries, and secret-shaped extra properties.
- Candidate references must identify knowledge that was effectively published
  at the observation time. Open privacy holds, erased identities, purged source
  content, expired retention, future observations, and changed replays fail.
- Insights contain only closed topic/category/language codes and counts. A group
  requires the configured number of distinct authoritative contacts rather than
  conversations, and its retention deadline is the earliest contributing
  deadline. Aggregation rechecks current privacy holds, deletion markers, and
  source-content purging before counting an observation.
- Repeated aggregate runs link new insights to one stable unresolved question
  instead of generating duplicate unchanged questions. Fresh insight after an
  answered or dismissed question opens a new question generation.
- Digest creation is serialized in PostgreSQL. The interval is at least three
  days, each digest contains at most five questions, unchanged questions obey a
  configurable cooldown and appearance ceiling, and empty runs create no row.
- The group threshold, digest interval, maximum questions, cooldown, appearance
  ceiling, and per-run observation bound are protected environment settings;
  operational values are not source-code-only policy.
- The private dashboard reauthorizes a knowledge editor inside the transaction.
  A bilingual owner answer creates an append-only answer and `support_gap` draft
  through `PostgresKnowledgeRepository`. Tests prove zero review and publication
  events are created by this path.

## Test-first and validation evidence

The focused learning integration suite was first run with the digest and answer
methods absent and failed at type checking. The implemented focused gates then
passed:

- `npm test -- --run tests/admin-config.test.ts tests/admin-app.test.ts`: 2 files,
  40 tests passed.
- Guarded PostgreSQL learning/dashboard run: 2 files, 24 tests passed.
- `npm run check`: Phase 0 validator, formatting, lint, strict type checking,
  build, and 317 unit tests across 28 files passed.
- Complete guarded PostgreSQL suite: 296 tests across 21 files passed.
- `git diff --check`: passed before documentation finalization.

All fixtures are synthetic. The raw-message sentinel is asserted absent from
learning results and owner questions. No credential, token, customer data, raw
message, external identity, or secret value is present in this evidence.

Independent review found and prompted regression fixes for terminal question
generations, post-observation privacy/purge state, person-level suppression,
database-authoritative role checks, and answer-time privacy-state races. All
five regression groups pass locally.

## Deliberate non-claims

- No live browser, Manifest, model, provider, Meta, n8n, tunnel, SSH, deployment,
  or production test was run for Task 9.
- The Task 8 synthetic desktop/mobile browser evidence remains limited to the
  dashboard foundation and does not establish deployed or live-database browser
  integration.
- The sensitive-data gate, FAQ-first resolver, Manifest client, model policies,
  safe fallback/escalation flow, and bilingual evaluation set remain later
  Phase 4 tasks.
