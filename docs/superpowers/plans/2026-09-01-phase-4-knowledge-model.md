# Phase 4 Knowledge, Learning, And Model Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Phase 4 PostgreSQL knowledge catalog, private administration foundation, proposal-only learning loop, FAQ/redaction boundary, tool-free Manifest client, customizable model limits and safe failure, and synthetic English/Bangla evaluation without making any live provider, infrastructure, Meta, or production change.

**Architecture:** PostgreSQL remains authoritative for immutable knowledge versions, review/publication history, administrative identity, learning state, operational model policy, leases, reply drafts, and escalations. The public webhook process keeps only Meta admission routes; a separate loopback-bound Fastify admin process calls typed domain services. A reply-decision service runs redaction before FAQ matching, uses published FAQ answers without inference, and can reach only a fail-closed Manifest adapter after PostgreSQL allowance and runtime-attestation checks. Every customer-derived Phase 4 record participates in the existing privacy, deletion, retention, takeover, and suppression rules.

**Tech Stack:** Node.js 24, strict TypeScript 6, Fastify 5, PostgreSQL 18 with `node-pg-migrate`, `pg`, Zod 4, Vitest 4, Node `crypto`/`fetch`, Prettier, ESLint.

**Spec:** `docs/superpowers/specs/2026-09-01-phase-4-knowledge-model-design.md`

## Global Constraints

- Work on `main` in the approved sequence and push each completed, validated checkpoint so `main` and `origin/main` remain synchronized.
- Use test-first development: add the focused failing test, run it and confirm the expected failure, add the smallest implementation, then run the focused and relevant regression suites.
- Use only newly authored synthetic fixtures that comply with `docs/SYNTHETIC_FIXTURE_POLICY.md`.
- Never print, store in evidence, commit, or send credentials, tokens, raw customer messages, provider bodies, sensitive matches, or secret values.
- Do not call Meta, Manifest, n8n, Cloudflare, public Internet endpoints, live models/providers, or the Ubuntu test server. Do not change Docker networks, tunnel routes, external configuration, or production assets.
- Keep `src/app.ts` free of admin routes. The initial admin listener defaults to `127.0.0.1`; no Compose or tunnel attachment is part of Phase 4.
- Model requests use only `MANIFEST_BASE_URL`, the dedicated `fcd-support` API key, and `model: "auto"`; requests contain no tool, function, plugin, provider, or fallback fields.
- Operational values live in approved PostgreSQL policy versions and are intersected with deployment ceilings. Missing policy, missing attestation, or invalid configuration disables inference.
- Database migrations use closed relational columns, bounded text, foreign keys, append-only evidence, idempotency keys, and rollback refusal when downgrade would discard Phase 4 evidence.
- At every checkpoint, review staged paths and run a secret/privacy scan before commit. Never use raw message text or diagnostic bodies in assertions, snapshots, logs, or commit messages.

---

## Task 1: Create the knowledge catalog schema

**Files:**

- Create: `migrations/000009_create_knowledge_catalog.ts`
- Modify: `tests/integration/migrations.test.ts`

**Schema contract:**

- `knowledge_sources`: opaque identity, closed `manual_business|website|policy|support_gap` type, bounded label, optional approved URL, active flag, creator reference, timestamps.
- `knowledge_source_snapshots`: source reference, fetch/outcome times, closed outcome, SHA-256 source/content digests, bounded proposed public content, creator reference, request key.
- `knowledge_items`: stable bounded opaque key, closed `faq|business_fact|safety_response|escalation_response` kind, timestamps.
- `knowledge_versions`: item reference, monotonically increasing version number, proposal request key, closed state `draft|submitted|approved|rejected`, bilingual questions/answers as required by kind, source/snapshot references, digests, author, replacement/rollback lineage, created/submitted/decided times.
- `knowledge_aliases`: version reference, `en|bn`, closed `question|alias|intent|example` kind, original bounded phrase and deterministic normalized phrase.
- `knowledge_tags`: version reference and bounded normalized tag.
- `knowledge_review_events`: append-only `submit|approve|reject` event, reviewer, bounded reason, request key, time.
- `knowledge_publication_events`: append-only `publish|retire|rollback` event, exact version, optional superseded/prior version for publish, required prior version for rollback, no invented prior version for retirement, reviewer, effective time, request key, and creation time.
- Database functions/triggers reject mutation/deletion of submitted versions and all review/publication history; unique and exclusion/trigger rules prevent two effective publications for one item at the same serialized decision point.
- Enable `pg_trgm` and add bounded trigram lookup indexes to the normalized alias columns in the original catalog migration.

**Steps:**

- [x] Add an integration test that expects all eight catalog tables, required indexes, immutable-history triggers, and migration count nine.
- [x] Run `npm run test:integration -- --run tests/integration/migrations.test.ts` and confirm failure because migration 000009 is absent.
- [x] Implement migration 000009 with `pg_trgm`, bounded checks, foreign keys, append-only triggers, per-item version uniqueness, request-key uniqueness, trigram lookup indexes, and a guarded `down` migration that refuses when catalog evidence exists.
- [x] Extend the migration test with invalid-state, invalid-bilingual-content, history-mutation, guarded-down, clean-down, and reapply assertions.
- [x] Run the focused migration test and confirm it passes.
- [x] Run `npm run typecheck`, `npm run format:check`, and `git diff --check`.
- [x] Commit with `feat: add phase 4 knowledge catalog schema` and push `main`.

## Task 2: Define closed knowledge inputs and normalization

**Files:**

- Create: `src/knowledge/knowledge-types.ts`
- Create: `src/knowledge/knowledge-input.ts`
- Create: `src/knowledge/faq-normalization.ts`
- Create: `tests/knowledge-input.test.ts`
- Create: `tests/faq-normalization.test.ts`

**Interfaces:**

- `KnowledgeProposalInput`, `KnowledgeReviewCommand`, `KnowledgePublicationCommand`, `PublishedKnowledgeVersion`, and closed result unions.
- `parseKnowledgeProposal`, `parseKnowledgeReviewCommand`, and `parseKnowledgePublicationCommand` reject unknown fields, invalid dates, generic patches, unbounded content, malformed tags/URLs, and missing bilingual FAQ fields.
- `normalizeFaqText(text)` performs NFKC, locale-safe case normalization, bounded whitespace/punctuation folding, and rejects excessive or malformed input.

**Steps:**

- [x] Write tests for strict parsing, bilingual requirements, provenance requirements, URL restrictions, bounded arrays/text, request keys, and unknown-field rejection.
- [x] Write English and Bangla normalization tests covering NFKC, Unicode punctuation, whitespace, Bangla digits/marks, English case, and input bounds.
- [x] Run `npm test -- --run tests/knowledge-input.test.ts tests/faq-normalization.test.ts` and confirm module-not-found failures.
- [x] Implement the closed types, Zod parsers, and deterministic normalizer without database or model dependencies.
- [x] Run the focused tests and then `npm run check`.
- [x] Commit with `feat: define phase 4 knowledge contracts` and push `main`.

## Task 3: Implement proposal creation and immutable versioning

**Files:**

- Create: `src/persistence/postgres-knowledge-repository.ts`
- Create: `tests/integration/postgres-knowledge-repository.test.ts`
- Modify: `migrations/000009_create_knowledge_catalog.ts`
- Modify: `src/knowledge/knowledge-types.ts`
- Modify: `src/policy/reviewer-principal.ts`
- Modify: `tests/integration/migrations.test.ts`

**Interfaces:**

- `PostgresKnowledgeRepository.createSource(input, principal)`.
- `recordSourceSnapshot(input, principal)` creates proposal evidence only.
- `createProposal(input, principal)` returns `created|duplicate`; the same request key with different material throws the existing idempotency-conflict class.
- `createReplacementProposal(input, principal)` always creates a new version and never updates submitted/approved content.
- `getVersion(ref)` returns a typed view without unrestricted database rows.

**Steps:**

- [x] Add guarded PostgreSQL tests for manual and website sources, provenance, monotonically increasing versions, exact replay, conflicting replay, author roles, website proposal-only behavior, and immutable submitted data.
- [x] Run the focused integration test and confirm failure because the repository does not exist.
- [x] Implement the repository using `withBoundedTransaction`, per-item advisory locks, material comparison, typed row mapping, and explicit column lists. Self-review identified and added the proposal request-key column before any Phase 4 schema deployment.
- [x] Add concurrent version-creation and rollback-on-invalid-child tests.
- [x] Run the focused integration test, `npm run check`, and all guarded PostgreSQL tests.
- [x] Commit with `feat: implement knowledge proposal repository` and push `main`.

## Task 4: Implement review, publication, retirement, and rollback

**Files:**

- Create: `src/knowledge/knowledge-reviewer.ts`
- Create: `src/persistence/postgres-knowledge-publication.ts`
- Create: `tests/integration/postgres-knowledge-publication.test.ts`
- Modify: `src/policy/reviewer-principal.ts`
- Modify: `src/knowledge/knowledge-types.ts`

**Interfaces:**

- Add role guards for `knowledge_editor`, `knowledge_reviewer`, and `administrator` while preserving Phase 3 reviewer semantics.
- `submitVersion`, `reviewVersion`, `publishVersion`, `retireItem`, and `rollbackItem` accept exact version references and typed commands.
- `resolveEffectiveVersion(itemKey, evaluatedAt)` and `listEffectiveVersions(kind, evaluatedAt)` derive authority from event history.

**Steps:**

- [x] Write failing tests for role denial, exact-version confirmation, author/reviewer identity, submit/approve/reject state transitions, replay/conflict, and unpublished/future/rejected invisibility.
- [x] Add failing tests for one effective version, serialized concurrent publication, retirement, replacement, and rollback to a previously approved version without history mutation.
- [x] Run the focused integration test and confirm the missing service failures.
- [x] Implement typed reviewer orchestration and PostgreSQL publication with per-item advisory locks and append-only events. Self-review clarified that retirement identifies its own active version; prior-version confirmation binds superseding publish and rollback actions.
- [x] Run focused tests, the migration test, `npm run check`, and all guarded PostgreSQL tests.
- [x] Commit with `feat: implement reviewed knowledge publication` and push `main`.

## Task 5: Add admin identity, learning, draft, and audit schema

**Files:**

- Create: `migrations/000010_create_phase4_admin_learning.ts`
- Modify: `tests/integration/migrations.test.ts`

**Schema contract:**

- Admin: `admin_accounts`, `admin_role_assignments`, `admin_mfa_credentials`, `admin_sessions`, and append-only `admin_audit_events` with normalized login uniqueness, password algorithm/parameters/salt/hash, encrypted MFA material, revocation, expiry, hashed session/CSRF values, closed roles/actions/results, and no plaintext credential fields.
- Learning: `knowledge_gap_observations`, `customer_insight_runs`, `customer_insight_entries`, `owner_questions`, `owner_question_insights`, `owner_question_answers`, and `owner_question_digests` with closed categories, aggregate counts, retention deadlines, request keys, at-most-five digest membership, and no raw external identity/provider-body fields.
- Reply state: `support_reply_drafts` links one applied customer event/conversation to `faq|model|safe_failure`, language, bounded answer, primary FAQ version, retention deadline, and state; append-only `support_reply_draft_knowledge` records the bounded published references supporting FAQ/model drafts; `support_escalation_outcomes` stores only closed failure reason and internal references.
- Append-only evidence tables reject update/delete; mutable session/question state uses explicit row versions and closed transitions.

**Steps:**

- [x] Extend migration tests to expect the admin, learning, draft, and escalation tables and migration count ten.
- [x] Add negative schema tests proving plaintext password/session/MFA columns are absent, closed enums reject unknown values, digest size is bounded, and evidence history is append-only.
- [x] Run the focused migration test and confirm failure.
- [x] Implement migration 000010, guarded downgrade refusal, supporting indexes, and deletion/retention lookup indexes.
- [x] Run migration apply/down/reapply tests, typecheck, formatting, and diff checks.
- [x] Commit with `feat: add phase 4 admin and learning schema` and push `main`.

## Task 6: Implement cryptographic admin authentication primitives

**Files:**

- Create: `src/admin/admin-types.ts`
- Create: `src/admin/password-hash.ts`
- Create: `src/admin/mfa.ts`
- Create: `src/admin/session-token.ts`
- Create: `src/admin/csrf.ts`
- Create: `tests/admin-auth.test.ts`

**Interfaces:**

- Password hashes use versioned Node `crypto.scrypt` parameters, a unique random salt, constant-time verification, and explicit upgrade detection.
- MFA uses RFC 6238 TOTP with encrypted-at-rest seed material through an `AdminSecretProtector`; AES-256-GCM is the initial runtime adapter.
- Session and CSRF tokens use independent high-entropy values and store only keyed/cryptographic hashes.
- Secret-bearing values never implement unsafe stringification and never reach logger contexts.

**Steps:**

- [x] Write failing tests for password hash uniqueness/verification/wrong-password/tamper/upgrade, TOTP current-window/replay/outside-window behavior, AES-GCM tamper failure, session entropy/hash comparison, and CSRF origin/token rejection.
- [x] Run the focused test and confirm module-not-found failures.
- [x] Implement the primitives with injected randomness/time for deterministic tests and bounded inputs.
- [x] Run focused tests and `npm run check`.
- [x] Commit with `feat: add private admin authentication primitives` and push `main`.

## Task 7: Implement PostgreSQL admin accounts and sessions

**Files:**

- Create: `src/persistence/postgres-admin-identity.ts`
- Create: `tests/integration/postgres-admin-identity.test.ts`
- Create: `src/admin/admin-bootstrap.ts`
- Create: `tests/admin-bootstrap.test.ts`
- Modify: `package.json`

**Interfaces:**

- `PostgresAdminIdentity.createAccount`, `assignRole`, `revokeRole`, `beginPasswordAuthentication`, `completeMfaAuthentication`, `resolveSession`, `revokeSession`, and `revokeAllSessions`.
- Failed authentication returns one generic result; account existence and credential details are not exposed.
- MFA codes are one-time within the accepted window. Successful MFA rotates the pre-authentication session into a full session.
- `npm run admin:bootstrap` reads login/password/MFA seed from masked standard input, writes no secret, and uses the same account service; it cannot publish knowledge or bypass role checks.

**Steps:**

- [ ] Add failing integration tests for individual accounts, normalized login collision, password/MFA flow, generic failure, role changes, session rotation/expiry/revocation, concurrent replay, and content-free audit history.
- [ ] Add failing unit tests for bootstrap input handling and secret-free output/error behavior.
- [ ] Run focused tests and confirm failure.
- [ ] Implement the transactional identity service and one-shot bootstrap entrypoint using bounded queries and append-only audit.
- [ ] Run focused tests, `npm run check`, and all guarded PostgreSQL tests.
- [ ] Commit with `feat: implement private admin identity store` and push `main`.

## Task 8: Build the loopback-only admin service and knowledge dashboard

**Files:**

- Create: `src/admin/admin-config.ts`
- Create: `src/admin/admin-app.ts`
- Create: `src/admin/admin-html.ts`
- Create: `src/admin/admin-runtime.ts`
- Create: `src/admin-main.ts`
- Create: `tests/admin-config.test.ts`
- Create: `tests/admin-app.test.ts`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `src/logging.ts`
- Modify: `tests/app.test.ts`

**Route contract:**

- `fcd-support-admin` defaults to `127.0.0.1:3004`; non-loopback binding requires an explicit future private-TLS mode not implemented here.
- Login, MFA, logout, proposal list/detail/create, submit/review, publish confirmation/execute, retire/rollback confirmation/execute, questions/answers, insights, active policy, escalation counts, and audit history are private routes.
- Browser mutations require authenticated role, exact `Origin`, SameSite/HttpOnly/Secure-when-TLS cookie, and CSRF token. HTML uses a restrictive CSP and never injects unescaped content.
- The public `buildApp` continues returning `404` for every admin path.

**Steps:**

- [ ] Write config tests proving loopback default, invalid key/port failure, and non-loopback refusal.
- [ ] Write Fastify injection tests for login/MFA/session/logout, CSRF/origin checks, role denial, exact version confirmation, safe error pages, security headers, and module route coverage.
- [ ] Extend public app tests to prove representative `/admin` and `/api/admin` routes remain absent.
- [ ] Run focused tests and confirm failures.
- [ ] Implement the separate admin app/runtime and minimal server-rendered dashboard using typed domain-service ports; add `start:admin` without changing `start`.
- [ ] Add only configuration names and blank secret values to `.env.example`: admin host/port, session-HMAC key, MFA-encryption key, origin, and secure-cookie mode.
- [ ] Run focused tests and `npm run check`.
- [ ] Commit with `feat: add private knowledge administration service` and push `main`.

## Task 9: Implement proposal-only learning and owner questions

**Files:**

- Create: `src/learning/learning-types.ts`
- Create: `src/learning/learning-input.ts`
- Create: `src/persistence/postgres-learning-service.ts`
- Create: `tests/learning-input.test.ts`
- Create: `tests/integration/postgres-learning-service.test.ts`
- Modify: `src/admin/admin-app.ts`
- Modify: `tests/admin-app.test.ts`

**Interfaces:**

- `recordGapObservation` accepts an applied internal event, `en|bn`, closed gap kind, bounded candidate references, optional sanitized summary, and retention deadline.
- `aggregateInsights` writes aggregate topic/category counts, suppresses low-count groupings, and inherits the strictest contributing retention deadline.
- `openQuestionDigest` runs on an injected UTC time, opens at most one digest every three days, chooses at most five unresolved non-repeating questions, and produces no row when empty.
- `answerOwnerQuestion` requires an authenticated reviewer, records an append-only answer, and creates a draft proposal through `PostgresKnowledgeRepository`; it cannot submit, approve, or publish it.

**Steps:**

- [ ] Write unit tests for closed inputs, bounded summaries, no external identities, and forbidden raw/sensitive fields.
- [ ] Write failing integration tests for event authority, replay/conflict, aggregate-only insights, low-count suppression, three-day/max-five digests, cooldown, concurrent digest creation, and empty runs.
- [ ] Add failing tests proving owner answers create only draft proposals and cannot use a publication shortcut.
- [ ] Run focused tests and confirm failures.
- [ ] Implement the learning service with transaction/advisory locks, typed joins, and content-minimized evidence.
- [ ] Wire dashboard question/insight reads and answer commands through typed ports.
- [ ] Run focused tests, `npm run check`, and all guarded PostgreSQL tests.
- [ ] Commit with `feat: implement proposal-only knowledge learning` and push `main`.

## Task 10: Implement the fail-closed sensitive-data gate

**Files:**

- Create: `src/safety/sensitive-data-types.ts`
- Create: `src/safety/sensitive-data-gate.ts`
- Create: `src/safety/safe-responses.ts`
- Create: `tests/sensitive-data-gate.test.ts`
- Create: `tests/safe-responses.test.ts`

**Interface:**

- `inspectSensitiveText(input, language)` returns `safe`, `redacted`, or `blocked` with closed category/reason codes, typed markers, and no matched values.
- Hard-block classes cover passwords/auth secrets, OTP/recovery, API keys/tokens/cookies/sessions, payment/bank, private keys/credential files, sensitive incident evidence, ambiguity, malformed Unicode, and excessive input.
- Redaction may continue only when deterministic removal leaves an unambiguous bounded support question.
- `safeResponse(language, reason)` returns reviewed deterministic English/Bangla text for block, limit, provider, validation, and human-escalation outcomes.

**Steps:**

- [ ] Add synthetic unit cases for every hard-block class, allowed false-positive controls, multi-secret input, unsafe ambiguity, typed redaction, malformed/excessive input, and English/Bangla response selection.
- [ ] Add assertions that serialized results, errors, and logger-shaped contexts contain no original matched value.
- [ ] Run focused tests and confirm failures.
- [ ] Implement bounded deterministic recognizers, context checks, typed markers, and closed result unions without model use.
- [ ] Run focused tests and `npm run check`.
- [ ] Commit with `feat: add sensitive data inference gate` and push `main`.

## Task 11: Implement FAQ-first resolution from effective knowledge

**Files:**

- Create: `src/knowledge/faq-resolver.ts`
- Create: `src/persistence/postgres-faq-resolver.ts`
- Create: `tests/faq-resolver.test.ts`
- Create: `tests/integration/postgres-faq-resolver.test.ts`

**Interfaces:**

- `FaqResolution` is `match|ambiguous|miss`; `match` includes exact stored answer, language, opaque item/version references, and closed match kind.
- Resolver accepts only sanitized normalized input and an evaluation time.
- Exact question/alias/example matching precedes bounded `pg_trgm` similarity. Threshold and ambiguity margin are supplied policy values, never model-controlled constants.

**Steps:**

- [ ] Write pure ranking tests for exact precedence, strong single score, close-score ambiguity, below-threshold miss, language selection, and deterministic ties.
- [ ] Write integration tests with approved published/future/retired/rejected/incomplete bilingual versions proving only one effective eligible version can answer.
- [ ] Run focused tests and confirm failures before implementation.
- [ ] Implement query and pure decision layers with bounded candidate count and no model dependency.
- [ ] Run focused tests, migration tests, `npm run check`, and all guarded PostgreSQL tests.
- [ ] Commit with `feat: implement published faq first resolution` and push `main`.

## Task 12: Add the Phase 4 reply-decision boundary and Phase 3 guards

**Files:**

- Create: `src/replies/reply-types.ts`
- Create: `src/replies/reply-decision-service.ts`
- Create: `src/persistence/postgres-reply-draft-store.ts`
- Create: `tests/reply-decision-service.test.ts`
- Create: `tests/integration/postgres-reply-draft-store.test.ts`
- Modify: `src/persistence/postgres-takeover-policy.ts`
- Modify: `src/persistence/postgres-privacy-rights-policy.ts`
- Modify: `src/persistence/postgres-deletion-policy.ts`
- Modify: `src/persistence/postgres-retention-job.ts`
- Modify: `src/persistence/postgres-access-export.ts`
- Modify: corresponding integration tests for takeover, privacy rights, deletion, retention, and access export

**Flow contract:**

- Claim one applied customer event; recheck human pause, privacy hold, verified deletion/suppression, and event idempotency.
- Run sensitive inspection before FAQ. A blocked result creates one deterministic safe draft and one escalation without model allowance.
- A strong FAQ result stores the exact published answer/reference without model allowance.
- Ambiguity/miss records one gap and returns `model_required` to the later model boundary; Phase 4 still sends nothing to Meta.
- Recheck all Phase 3 guards immediately before draft creation. A newly effective guard wins.
- Deletion and retention clear draft text and customer-derived gap summaries; access export includes allowlisted Phase 4 categories; restored deletion remains suppressive.

**Steps:**

- [ ] Write failing unit tests for ordering, no-model FAQ path, hard-block escalation, ambiguity/miss gap creation, and guard-race outcomes using injected ports.
- [ ] Write failing PostgreSQL tests for exact replay, concurrent claim/draft, takeover/privacy/deletion/suppression races, and no unauthorized draft.
- [ ] Extend deletion, retention, restore, and access-export tests for all new customer-derived columns and records.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Implement the decision service and draft store, then extend Phase 3 privacy services transactionally.
- [ ] Run focused tests, `npm run check`, and all guarded PostgreSQL tests.
- [ ] Commit with `feat: integrate faq decisions with policy core` and push `main`.

## Task 13: Add fail-closed Manifest configuration and request/output contracts

**Files:**

- Create: `src/model/model-types.ts`
- Create: `src/model/model-config.ts`
- Create: `src/model/manifest-request.ts`
- Create: `src/model/manifest-output.ts`
- Create: `tests/model-config.test.ts`
- Create: `tests/manifest-request.test.ts`
- Create: `tests/manifest-output.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Configuration accepts `MANIFEST_BASE_URL`, blank-or-secret API key, exact `MANIFEST_MODEL=auto`, and non-secret recording/provider/private-route/deletion attestations.
- Deployment ceilings cover contact windows, global day, concurrency, queue, timeout, output tokens, cooldown, provider-attempt attestation, response-byte limit, context items, and input characters.
- `buildManifestRequest` emits one non-streaming `/chat/completions` request with bounded system policy, redacted text/context, published facts, required language, `model: "auto"`, and `max_tokens`; it emits no tool/provider/fallback fields.
- `parseManifestOutput` validates strict JSON into `decision`, `language`, `answer`, `knowledgeReferences`, `reasonCode`, and `needsHumanReview`, including supported-reference, fact, URL, language, secret-shape, tool/action-claim, and size checks.

**Steps:**

- [ ] Write failing configuration tests for each missing/false attestation, invalid `auto`, public/non-private URL, absent ceilings, and stricter-ceiling semantics.
- [ ] Write request tests asserting exact keys and recursively proving forbidden tool/provider/function/plugin fields are absent and input is bounded/redacted.
- [ ] Write output tests for every invalid schema/claim/reference/language/secret/URL/size outcome and valid answer/escalate envelopes.
- [ ] Run focused tests and confirm failures.
- [ ] Implement strict parsers/builders; expose only blank secret names and documented non-secret attestations/ceilings in `.env.example`.
- [ ] Run focused tests, `npm run check`, credential-name/value scans, and `git diff --check`.
- [ ] Commit with `feat: define fail closed manifest contracts` and push `main`.

## Task 14: Implement the single-attempt Manifest HTTP client with local fakes

**Files:**

- Create: `src/model/manifest-client.ts`
- Create: `tests/manifest-client.test.ts`
- Create: `tests/helpers/fake-manifest-server.ts`
- Modify: `src/logging.ts`
- Modify: `tests/logging.test.ts`

**Interface:**

- `ManifestClient.complete(input, signal)` makes one non-streaming POST to the configured private base URL and returns a closed local result.
- The client combines caller abort and total timeout, bounds response bytes before JSON parsing, ignores/logs no error body, never retries, and never contacts a second host.
- Safe reason codes cover timeout, aborted, network failure, non-2xx, oversized body, malformed body, invalid envelope, and provider exhaustion without provider names.

**Steps:**

- [ ] Build an in-process loopback HTTP fake that captures only sanitized request structure and never accepts or records real secrets.
- [ ] Write failing contract tests for URL/path, auth header presence without value snapshots, `auto`, no tools/provider fields, redacted input, timeout/abort, one request only, non-2xx, malformed/oversized bodies, and valid structured output.
- [ ] Run focused tests and confirm failures.
- [ ] Implement the client with injected `fetch`, timers, and safe logger events.
- [ ] Run focused tests and `npm run check`.
- [ ] Commit with `feat: add tool free manifest http client` and push `main`.

## Task 15: Add customizable model policy, usage, and lease schema

**Files:**

- Create: `migrations/000011_create_model_policy.ts`
- Modify: `tests/integration/migrations.test.ts`

**Schema contract:**

- `model_policy_versions`: immutable version, state, approved-by/time, activation/retirement time, per-contact short/24h values, global UTC-day limit, concurrency, queue capacity, timeout, output tokens, cooldown, FAQ threshold/margin, approved provider-attempt count, and architecture provider ceiling.
- `model_policy_review_events`: append-only submit/approve/activate/retire events with request keys.
- `model_usage_windows`: pseudonymous/internal contact key, closed window kind/start/end, count, expiry, policy version.
- `model_call_leases`: logical call key, event/conversation, policy version, `queued|active|completed|failed|expired`, lease expiry, content-free outcome, timestamps.
- Indexes and constraints serialize active policy, counters, queue/concurrency capacity, logical-call idempotency, and expiry cleanup.

**Steps:**

- [ ] Add migration tests for tables, columns, closed constraints, immutable policy/history, migration count eleven, and absence of prompt/response/provider-name fields.
- [ ] Add guarded downgrade refusal and clean down/reapply tests.
- [ ] Run the focused migration test and confirm failure.
- [ ] Implement migration 000011 with the balanced approved values represented only in synthetic test inserts, never column defaults or source constants.
- [ ] Run migration tests, typecheck, formatting, and diff checks.
- [ ] Commit with `feat: add customizable model policy schema` and push `main`.

## Task 16: Implement active policy resolution, counters, leases, and escalation

**Files:**

- Create: `src/model/model-policy-types.ts`
- Create: `src/model/model-policy-input.ts`
- Create: `src/persistence/postgres-model-policy.ts`
- Create: `src/persistence/postgres-model-allowance.ts`
- Create: `src/persistence/postgres-support-escalation.ts`
- Create: `tests/model-policy-input.test.ts`
- Create: `tests/integration/postgres-model-policy.test.ts`
- Create: `tests/integration/postgres-model-allowance.test.ts`
- Create: `tests/integration/postgres-support-escalation.test.ts`
- Modify: `src/admin/admin-app.ts`
- Modify: `tests/admin-app.test.ts`

**Interfaces:**

- Policy commands create, submit, approve, activate, and retire immutable versions through exact role and idempotency checks.
- `resolveEffectivePolicy(at, ceilings, manifestAttestation)` returns disabled or the field-by-field stricter intersection.
- `acquireModelAllowance` atomically applies short/24h contact counters, global UTC-day counter, cooldown, queue capacity, concurrency, exact logical-call idempotency, and lease expiry.
- `activateLease`, `completeLease`, and `expireLeases` use closed transitions; crashes cannot yield unbounded calls or retries.
- `recordEscalation` is content-free and idempotent.

**Steps:**

- [ ] Write parser tests proving all limits are customizable positive bounded values and no source default silently enables inference.
- [ ] Write integration tests for active/future/retired policies, stricter intersections, exact replay/conflict, role checks, and concurrent activation.
- [ ] Write concurrency tests for 3/15m, 20/24h, 300/UTC-day, four active, queue 25, cooldown, expiry, crash/retry, and policy changes using synthetic inserted policy values rather than production constants.
- [ ] Write escalation tests for every closed failure reason, idempotency, and absence of content/provider fields.
- [ ] Run focused tests and confirm failures.
- [ ] Implement policy, allowance, lease, and escalation services with bounded transactions/advisory locks.
- [ ] Add dashboard policy review/activation and aggregate failure views through exact typed commands.
- [ ] Run focused tests, `npm run check`, and all guarded PostgreSQL tests.
- [ ] Commit with `feat: enforce customizable model limits and leases` and push `main`.

## Task 17: Compose safe model decisions and create Phase 4 evidence

**Files:**

- Create: `src/replies/model-reply-service.ts`
- Create: `tests/model-reply-service.test.ts`
- Create: `tests/integration/postgres-model-reply-flow.test.ts`
- Create: `tests/fixtures/phase4-evaluation.json`
- Create: `src/evaluation/phase4-evaluation.ts`
- Create: `tests/phase4-evaluation.test.ts`
- Create: `docs/testing/phase-4-evaluation-review.md`
- Create: `docs/architecture/knowledge-model-boundary.md`
- Create: `docs/operations/private-admin-and-model.md`
- Create: `docs/reviews/phase-4-gate.md`
- Modify: `docs/testing/acceptance-matrix.md`
- Modify: `docs/security/threat-model.md`
- Modify: `docs/TODO.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-09-01-phase-4-knowledge-model-design.md`

**Composition and evaluation contract:**

- The model reply service acquires one allowance, calls Manifest once, validates the envelope against supplied published facts, rechecks Phase 3 guards, then stores a model draft or one deterministic safe-failure draft plus escalation.
- FAQ drafts never call Manifest or consume allowance. Failed/invalid/exhausted model paths never fabricate business facts.
- The synthetic evaluation set covers AC-05, AC-10, AC-21, AC-22, and AC-25 in English and Bangla, including prompt injection, all sensitive classes, FAQ precedence, ambiguity, invalid output, timeout, provider exhaustion, limits, language switching, and proposal-only learning.
- The scorer requires 100% invariant outcomes for FAQ precedence, sensitive non-disclosure, no tools, safe failure, unsupported-claim rejection, language selection, and deterministic escalation. Synthetic generative fixtures require at least 90% acceptable and zero critical failures; this is local fake evidence, not a real-provider result.

**Steps:**

- [ ] Write failing unit tests for the complete FAQ/model/safe-failure composition, exactly one logical request, allowance completion, timeout, invalid output, unsupported claim, guard race, and escalation idempotency.
- [ ] Write guarded PostgreSQL flow tests proving crash/replay safety, no duplicate drafts/calls, customizable policy use, and deletion/takeover/privacy precedence.
- [ ] Author the reviewed synthetic English/Bangla fixture set with provenance comments in the review document; run the repository fixture-policy scan before accepting it.
- [ ] Write the deterministic scorer and failing threshold/critical-case tests, then implement until all local fixture outcomes pass.
- [ ] Run focused tests, `npm run check`, and `npm run test:integration` with the guarded isolated test environment. Record exact file/test counts from actual output only.
- [ ] Run `git diff --check`, a changed-file credential/secret/customer-data scan, tracked synthetic-fixture scan, schema/lock hygiene checks, and staged-file review.
- [ ] Update the architecture contract, private operations guide, threat model, acceptance items, tracker, project context, and Phase 4 gate with exact local evidence and explicit unresolved live Manifest/test-asset/P6/P7 blockers.
- [ ] Correct the duplicated numbered line in the P4-001 spec while preserving its approved meaning.
- [ ] Re-run the complete local and guarded PostgreSQL gates after documentation formatting.
- [ ] Commit with `feat: complete phase 4 knowledge and model boundary` and push `main`.

## Final Completion Conditions

Phase 4 is locally complete only when:

- all P4-002 through P4-006 behavior is implemented test-first;
- every Phase 3 privacy/takeover/retention/deletion interaction passes with the new Phase 4 data;
- the public API exposes no admin route and the admin runtime remains loopback-only;
- no test made a live external call and no evidence claims one;
- `npm run check`, the full guarded PostgreSQL suite, formatting, secret/privacy scans, `git diff --check`, schema/lock hygiene, and staged review all pass;
- the gate record distinguishes local fake/contract evidence from later private Manifest and Meta test-asset validation; and
- the final commit is pushed with clean `main` equal to `origin/main`.

Phase 4 completion does not authorize deployment, Manifest mutation or live traffic, Docker network attachment, n8n notification, Meta outbound delivery, test-asset execution, customer data, or production action.
