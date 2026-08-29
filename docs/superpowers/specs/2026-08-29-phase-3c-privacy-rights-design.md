# Phase 3C Privacy Rights And Deletion Safety Design

## Status And Scope

This design extends the Phase 3 data-policy core with four deterministic
customer intents:

- `DELETE MY DATA`;
- `REQUEST MY DATA`;
- `CORRECT MY DATA`; and
- `STOP MARKETING`.

The project owner approved continuing with the recommended scope on 2026-08-29:
marketing opt-out applies immediately to every identity already linked to the
same authoritative contact, while deletion, access, and correction remain
human-reviewed workflows. The phrases are intent triggers, not authentication
secrets and not permission for unattended deletion, disclosure, or correction.

The work is decomposed into two tracker rows:

- `P3-006` implements verified deletion, HMAC suppression, deletion tombstones,
  local erasure, and restored-database enforcement primitives; and
- `P3-007` implements deterministic privacy-intent intake, access/correction
  case tracking, global marketing opt-out, content-free notification intents,
  and the manual online/offline completion checklist.

`P3-GATE` depends on both rows. Actual encrypted backup creation and isolated
container restore remain `P6-004`. Delivery of private notifications to n8n or
another operator channel remains `P6-006`; Phase 3 records a durable intent but
makes no network call. Secure delivery of an access export is an operator action
and must not use the public webhook or an ordinary WhatsApp attachment.

This design authorizes local repository implementation and guarded synthetic
PostgreSQL tests only. It does not authorize deployment, live customer data,
provider deletion, Meta changes, Cloudflare changes, production-number actions,
or scanning operator devices and offline archives.

## Considered Approaches

1. **Typed privacy ledger plus specialized policy actions (selected).** Use one
   bounded request ledger and checklist for human workflow state, while deletion,
   export, correction, and consent retain narrow services and schemas. This
   provides one operator queue without treating materially different rights as
   the same database mutation.
2. **Add behavior only to consent and deletion tables.** This would be smaller,
   but access and correction would have no durable lifecycle, notification,
   deadline, or offline completion evidence.
3. **Store a generic ticket with JSON payloads.** This is flexible but would
   invite free-form customer content, credentials, external identifiers, and
   unreviewed state transitions into an audit table.

The selected approach uses closed enums, internal references, bounded reason
codes, and content-free evidence. It deliberately avoids a generic workflow
engine, admin UI, natural-language model classifier, or external ticketing
integration.

## Deterministic Intent Boundary

A pure parser recognizes only an applied `customer_message` from an
authoritative webhook event. It performs Unicode normalization, case folding,
leading/trailing whitespace removal, and internal whitespace collapsing. One
terminal `.`, `!`, or `?` may be ignored. Substring matches are prohibited, so a
customer discussing the phrase does not accidentally open or execute a request.

The initial English command set is exactly the four phrases above. Bangla or
additional aliases require separately reviewed wording and table-driven tests;
the model is never the sole detector for a privacy right. Unrecognized or
ambiguous text follows the ordinary support path and may be escalated manually.

An exact command is sufficient to open a request or apply a marketing opt-out.
It is not sufficient to approve deletion, release an export, or change stored
facts. Passwords, OTPs, access tokens, payment credentials, security answers,
and other secrets are invalid verification evidence.

## Authoritative PostgreSQL Model

Migration `000004_create_privacy_rights.ts` adds the following bounded state.

### Privacy Requests

`privacy_requests` contains:

- an opaque internal request reference;
- request type: `deletion`, `access`, or `correction`;
- state: `received`, `awaiting_confirmation`, `human_review`, `in_progress`,
  `completed`, `partially_completed`, `rejected`, or `cancelled`;
- an optional contact and source-event reference while needed for execution;
- received, target, decision, completion, and update timestamps;
- bounded decision and reason codes;
- an optional opaque reviewer reference; and
- a unique idempotency key.

No request row stores a raw channel identity, message body, requested correction,
credential, free-form reviewer note, HMAC value, or generated export. References
that would retain customer data after deletion are nulled in the same deletion
transaction. The opaque request reference and content-free completion evidence
remain.

State transitions are validated, serialized, and append evidence to
`privacy_request_events`. History includes only request reference, old/new state,
bounded action/outcome/reason, actor kind, opaque reviewer reference, time, and
request key. History is append-only.

### Completion Checklist

`privacy_request_locations` records one row per approved location code, such as:

- `primary_postgres`;
- `manifest_recordings`;
- `meta_provider`;
- `pending_outbound`;
- `operator_exports`;
- `offline_archives`; and
- `backup_tombstone_gate`.

Each row stores only applicability, state, reviewer reference, checked time, and
a bounded outcome code. It never stores a path, filename, device name, account
identifier, customer content, or reviewer note. The registry is policy-owned and
versioned. A request cannot become `completed` while an applicable required
location is unresolved. The application cannot claim that an offline location
was searched or erased; an authorized human must attest to that step.

### Durable Notification Intents

`privacy_notification_intents` records that an operator notification is due. It
contains the internal request reference, notification type, state, attempt
counter, timestamps, and idempotency key. It contains no customer content,
external identity, HMAC, or credential. PostgreSQL owns the state. A later
private adapter may deliver it, but n8n never becomes authoritative.

### Suppression And Tombstones

`privacy_suppressions` contains only the canonical lifecycle fields:
`identity_hmac`, channel, category (`marketing_opt_out` or
`deletion_tombstone`), bounded reason code, effective time, HMAC key version, and
optional expiry. It has no raw identity and no message content.

The HMAC input is a versioned canonical encoding of channel, channel account,
and external identity. A dedicated runtime key is required; it is not committed,
logged, returned, or reused for Meta signature verification or encryption. Key
rotation keeps all versions needed to match unexpired records.

## Workflow Behavior

### `DELETE MY DATA`

The command idempotently opens a `deletion` request, places the affected
conversation identities under a privacy hold, and creates an operator
notification intent. The service acknowledges receipt but does not delete.

An authorized support reviewer verifies the same-channel context and obtains an
explicit confirmation phrase or the already-known customer name. Ambiguous,
disputed, cross-channel-only, or secret-based evidence cannot approve the
request. A reviewer decision uses a bounded request key and reason code.

Approved execution runs in a bounded transaction and is idempotent. It:

1. locks the contact and every currently linked identity;
2. computes tombstones before raw identity fields are removed;
3. clears or deletes live message/profile content, derived artifacts, pending
   outbound work, and other locally governed copies;
4. removes or detaches consent and conversation state that would identify the
   subject, without deleting the minimal suppression/tombstone;
5. nulls identifying request references;
6. records counts and bounded outcomes only; and
7. leaves external/offline checklist items unresolved until human completion.

Later events matching any unexpired deletion tombstone are accepted according to
the webhook retry contract but cannot recreate a contact, conversation, message,
consent, draft, or outbound action. Exact replay and concurrent execution produce
one final state and no duplicate notification or tombstone.

### `REQUEST MY DATA`

The command idempotently opens an `access` request, applies a privacy hold to
automated replies for the affected conversation, and notifies an operator. It
does not delete data or automatically disclose anything.

After proportionate same-channel human verification, a local export service
collects the subject's currently governed records through explicit allowlisted
collectors. The export includes a machine-readable manifest, collection time,
request reference, source categories, and the customer's data; it excludes
credentials, secrets, internal security controls, unrelated people, and raw
provider tokens. Every collector is independently testable and later schema
changes must add or explicitly waive a collector before the privacy gate passes.

The service never logs, commits, emails, or sends the export through the Meta
webhook. Tests consume the synthetic export in memory. Production delivery later
requires an approved encrypted, expiring private channel plus human review.
Offline and provider-held material is added or attested manually before the
request is completed.

### `CORRECT MY DATA`

The command idempotently opens a `correction` request, applies a privacy hold,
and notifies an operator. It never interprets following message text as a generic
database patch. An authorized reviewer selects an allowlisted field-specific
correction command, verifies supporting context without requesting a secret, and
records only a bounded outcome in the request ledger.

Phase 3 implements the request lifecycle and correction-command interface. A
field can be changed only when its authoritative domain model defines a typed
correction handler and tests. Unknown, immutable, security-sensitive, or
provider-owned fields remain manual checklist items and may produce a bounded
`partially_completed` or `rejected` result.

### `STOP MARKETING`

The command is an immediate customer revocation and does not wait for reviewer
approval. In one transaction, the service locks the source identity's contact,
finds every channel identity already linked to that same contact, and for each:

1. appends customer-authoritative revoke events for every currently known
   marketing consent category;
2. creates or refreshes a global `marketing_opt_out` HMAC suppression;
3. cancels any locally pending marketing intents when that table exists; and
4. records one content-free, idempotent aggregate result.

The global suppression overrides every category grant, including an older grant
and a grant restored from backup. It does not block transactional support replies
or human conversation. A later re-opt-in must be explicit, verified, and perform
two operations atomically: clear the global suppression for the selected linked
identity scope and append new category-specific grants. Merely receiving another
marketing message or reviewer note cannot clear it.

No new identity merge is attempted. "Linked" means identities already attached
to the same authoritative `contacts.id`; a future identity-linking feature must
have its own verified design and tests.

## Privacy Holds And Eligibility

An unresolved deletion, access, or correction request prevents AI/model replies
for the affected conversation and causes any future send-time eligibility check
to deny automated output. Human support may continue to resolve the request.
`STOP MARKETING` does not pause ordinary support, but global opt-out suppression
always denies promotional eligibility.

The hold is derived from authoritative request state rather than cached in n8n.
Completion, rejection, or cancellation releases the hold only when no other
blocking privacy request remains. Deletion remains terminal regardless of
request closure.

## Restore Enforcement Boundary

P3-006 provides database-level reconciliation primitives that accept an isolated
restored database plus the external current tombstone set. They reapply every
unexpired tombstone across live, derived, consent, request-reference, and future
outbound tables; exact repeats are safe. A content-free gate row records counts,
supported key versions, status, and Git revision.

A gate cannot pass when a key version is unavailable, a location reconciler
fails, a tombstoned identity remains materialized, or evidence insertion fails.
P3-006 does not create, decrypt, move, or promote backups. P6-004 owns those
operational steps and must refuse promotion unless this gate passes.

## Failure, Concurrency, And Security Rules

- Every command validates closed schemas before SQL.
- Customer commands prove an applied authoritative `customer_message` source.
- Reviewer commands require the existing `support_reviewer` role; policy-owned
  registry or exception changes require `policy_owner`.
- Advisory locks serialize idempotency keys; row locks serialize one subject.
- Reusing a request key with different material is an idempotency conflict.
- A notification insertion failure rolls back request creation or opt-out.
- Network notification failure never rolls back authoritative privacy state; the
  durable intent remains retryable.
- Errors, dry runs, and completion results contain counts and bounded codes only.
- Raw identities, HMACs, customer content, exports, paths, and credentials never
  enter logs, fixtures, audit evidence, or model prompts.
- If a customer posts a credential, privacy automation does not preserve or
  redistribute it; the separate human credential-incident procedure must require
  rotation/revocation and controlled purge.
- A legal-retention exception requires a bounded reason, policy-owner approval,
  restricted access, and an explicit review/expiry date. It cannot silently make
  a request appear fully completed.

## Test Strategy

Pure unit tests cover exact and non-exact phrase recognition, Unicode/case/
whitespace handling, terminal punctuation, substring rejection, invalid input,
and closed command/result schemas.

Guarded randomized-schema PostgreSQL tests cover:

- exact retry, logical retry, concurrency, rollback, and conflicting keys;
- authoritative same-channel source checks and reviewer authorization;
- rejection of password, OTP, credential, cross-identity, and ambiguous deletion
  verification;
- request transitions, holds, notification idempotency, and unresolved-location
  completion refusal;
- repeated deletion across live messages, profile/identity state, derived data,
  consent, requests, pending outbound placeholders, suppression, and tombstones;
- later-event and restored-backup resurrection resistance across supported HMAC
  key versions;
- access collector completeness, subject isolation, third-party exclusion, and
  no persistent or logged export;
- correction allowlists, unsupported fields, partial completion, and no generic
  patch path;
- immediate all-linked-identity marketing revocation, zero/one/many prior
  categories, global suppression precedence, later explicit re-opt-in, and no
  effect on support replies;
- append-only bounded evidence and absence of customer content, raw identities,
  HMACs, exports, paths, and credentials; and
- migration apply, rollback, and reapply.

Fixtures follow `docs/SYNTHETIC_FIXTURE_POLICY.md`. Tests never use Meta, n8n,
Manifest, Cloudflare, live tokens, live identities, customer data, or operator
files.

## Documentation And Tracker Changes

Implementation updates:

- `docs/architecture/data-lifecycle.md` with the four request workflows, global
  opt-out precedence, access/correction boundaries, checklist, and holds;
- `docs/testing/acceptance-matrix.md` with separate deletion, access, correction,
  and all-marketing opt-out cases;
- `docs/security/threat-model.md` with wrongful disclosure/correction, incomplete
  offline handling, credential-in-export, notification leakage, and identity-link
  confusion threats;
- `docs/TODO.md` with `P3-007`, `P3-GATE` dependency changes, and truthful
  evidence states; and
- `docs/PROJECT_CONTEXT.md` so the next-task statement is no longer stale.

No task is marked complete until its named tests, privacy scans, migration cycle,
full local check, guarded PostgreSQL suite, clean Git status, and independent
review pass. `P3-GATE` remains a separate explicit project-owner review.

## Approval Boundaries Preserved

Local implementation does not deliver notifications, contact providers, scan
offline devices, create customer exports from live data, modify the Ubuntu test
deployment, or exercise Meta test assets. Those actions require their later
tracker dependencies and explicit approval. Production privacy wording and the
applicable legal response deadlines remain a business/legal approval at
`P8-001`.
