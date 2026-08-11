# Phase 3A Conversation, Takeover, And Consent Design

Status: approved in conversation on 2026-08-11; written specification awaiting project-owner review.

## Purpose

Phase 3A makes conversation identity, human takeover, and marketing consent
deterministic and PostgreSQL-backed without inventing unresolved retention or
deletion policy. It completes tracker rows `P3-002` through `P3-004`. Rows
`P3-005` and `P3-006` remain blocked until their Phase 0 policy dependencies are
approved.

## Selected Approach

Use a staged policy core:

1. implement conversation and channel identity;
2. implement 24-hour human takeover and private authorized resume;
3. implement append-only channel/category consent;
4. stop before retention classification, deletion, suppression, backup replay,
   or Manifest recording cleanup.

Creating provisional retention or deletion behavior was rejected because it
would encode policy that the project owner has not approved. Pausing all Phase 3
work was rejected because identity, takeover, and consent are independently
specified and testable.

## Scope

Phase 3A includes:

- internal contacts that are not automatically merged across channels;
- channel identities scoped by channel and business account;
- one current support conversation per channel identity;
- exactly-once application of admitted webhook events;
- business-echo takeover, expiry, duplicate handling, and resume races;
- authenticated reviewer authorization at the service boundary;
- append-only consent grants and revocations;
- marketing eligibility scoped by channel and category;
- privacy-safe policy decisions and audit outcomes;
- real PostgreSQL integration tests in randomized guarded schemas.

Phase 3A excludes:

- public, tunnel, admin, or reviewer HTTP routes;
- WhatsApp coexistence or manual-app echo assumptions;
- cross-channel identity linking;
- lead/client classification and every retention job;
- deletion verification, suppression records, backup replay, and Manifest cleanup;
- outbound messages, provider calls, model calls, n8n calls, or live Meta assets.

## Data Model

Migration `000002` will add the following bounded state.

### Contacts And Conversations

`contacts` contains only an internal identifier and timestamps. A contact is not
proof that identities on separate channels belong to the same person.

`channel_identities` contains:

- internal contact foreign key;
- channel: `whatsapp` or `messenger`;
- channel account identifier;
- external contact identifier;
- first-seen and last-seen timestamps;
- unique `(channel, channel_account_id, external_contact_id)` constraint.

`conversations` contains:

- channel identity foreign key;
- current AI pause deadline, nullable;
- most recent authorized-resume timestamp, nullable;
- created and last-activity timestamps;
- a row version used for policy decisions;
- unique channel identity constraint for the initial one-current-conversation model.

No retention class is stored in Phase 3A.

### Exactly-Once Event Application

`webhook_event_applications` references one `webhook_events` row uniquely and
records the resulting conversation, bounded outcome, and application timestamp.
It does not copy message text. Only events whose Phase 2 admission outcome is
`pending` may create conversation state. The event, identity, conversation,
policy changes, and application record are committed in one transaction.

Concurrent workers claim work with row locking and `SKIP LOCKED`. The unique
webhook-event foreign key remains authoritative if a claim is retried after a
crash or process restart.

### Human Takeover

`human_pause_events` is append-only and contains:

- conversation foreign key;
- optional unique source webhook-event foreign key;
- action: `pause` or `resume`;
- effective timestamp;
- resulting pause deadline, nullable for resume;
- actor kind: `business_echo` or `reviewer`;
- opaque internal reviewer reference for authorized resume, nullable;
- unique reviewer request key for resume idempotency, nullable.

An unmatched business-authored echo sets the current pause deadline to the
later of the existing deadline and `occurred_at + 24 hours`. Replaying the same
source event cannot extend the pause. Phase 3A has no service-generated outbound
messages, so admitted Messenger business echoes are unmatched. Phase 5 must
correlate service-generated echoes before invoking this rule.

An authorized resume clears the current deadline and records
`last_authorized_resume_at`. A concurrently processed echo whose provider time
is not later than that resume timestamp cannot reinstate the pause. An echo that
genuinely occurs after the resume starts a new 24-hour pause.

WhatsApp manual-app/coexistence echoes remain unsupported until test-asset
evidence proves their exact contract. Messenger behavior is not used as proof of
WhatsApp coexistence.

### Consent

`consent_events` is append-only and contains:

- channel identity foreign key;
- category identifier;
- action: `grant` or `revoke`;
- exact approved wording and wording version;
- source: `customer_message` or `reviewer_recorded`;
- source timestamp;
- unique idempotency key;
- optional source webhook-event foreign key;
- created timestamp.

The latest event by source time determines eligibility for exactly one identity,
channel, and category; when timestamps are equal, the higher database event ID
wins. Eligibility is true only when that event is a grant. No row, a blank
category, blank wording, blank wording version, category mismatch, channel
mismatch, or latest revocation is always false. Consent never extends
support-content retention. Phase 3A never infers consent from arbitrary message
text: callers must supply a separately validated grant or revoke command with an
idempotency key and the exact approved wording shown to the customer.

### Policy Audit

`policy_audit_outcomes` records bounded decision type, outcome, reason code,
conversation or channel-identity reference, related event where applicable, and
evaluation time. It contains no message text, authorization material, raw
external identity, or arbitrary error content.

## Service Boundaries

Focused modules will expose these responsibilities:

- `PostgresConversationEventProcessor`: claim and apply one pending Phase 2 event.
- `PostgresTakeoverPolicy`: check current pause, apply business echo, and perform authorized resume.
- `PostgresConsentPolicy`: append consent changes and evaluate channel/category eligibility.
- `ReviewerPrincipal`: authenticated identity and roles supplied by a future private transport boundary.

The policy layer accepts a principal only from trusted internal code and still
requires the `support_reviewer` role before resume or reviewer-recorded consent.
No public Fastify route is added in Phase 3A. A later private route must perform
authentication before constructing the principal and must never be included in
Cloudflare Tunnel ingress.

Reply creation uses the takeover policy immediately before creating an outbound
intent. Phase 5 must call the same authoritative check again immediately before
provider send. A cached earlier decision never authorizes a later send.

## Transaction And Failure Rules

- PostgreSQL is the sole authority; no in-memory pause or consent cache decides eligibility.
- Transactions lock the affected conversation or identity row before mutation.
- Duplicate event, resume, grant, or revoke commands are successful no-ops.
- A failed state transition rolls back its application/audit record with it.
- Lock, statement, connection, and transaction timeouts remain bounded as in Phase 2.
- Database unavailability produces no successful state transition.
- Logs contain only allowlisted event names, bounded reason codes, counts, and request references.

## Test Strategy

Migration tests will prove clean apply, rollback, reapply, foreign keys,
uniqueness, bounded enums, and required consent fields.

Integration tests will prove:

- first customer event creates one contact, identity, conversation, and application;
- replay, restart, and concurrent application remain exactly once;
- identical external contact IDs under different business accounts remain separate;
- business echo pauses for exactly 24 hours and a duplicate cannot extend it;
- pause is active before the deadline and inactive at the exact deadline;
- unauthorized resume fails without mutation;
- authorized resume is idempotent;
- resume wins against an older concurrent echo, while a later echo starts a new pause;
- blank or missing consent is false and cannot create a grant;
- grant, revoke, re-grant, duplicate commands, channel mismatch, and category mismatch are deterministic;
- audit records contain no synthetic message text or authorization detail;
- database errors roll back the complete policy transition.

Unit tests will cover bounded input validation and principal role checks without a
database. The existing Phase 1 and Phase 2 suites must remain green.

## Repository And Test-Server Workflow

- Windows checkout `J:\DevDrive\fcd-support` is the only authoring, commit, and push source.
- GitHub `main` is the transfer boundary for approved test revisions.
- The Ubuntu server never receives ad-hoc copied source files and is not edited as a second source checkout.
- During an explicitly approved test-deployment gate, Ubuntu pulls the exact committed revision from GitHub before build or test execution.
- Pulling to Ubuntu does not authorize deployment, public ingress, Meta assets, live data, or production changes.

## Gate

Phase 3A implementation may begin only after the project owner reviews this
written specification and approves the subsequent test-first implementation
plan. Completing Phase 3A does not complete the Phase 3 gate: retention and
deletion tasks remain blocked until `P0-009` through `P0-012` are resolved.
