# Data Lifecycle, Deletion, And Restore Contract

## Status And Authority

This is the canonical policy contract for P0-009 through P0-012. It implements
the design approved on 2026-08-26 in
`docs/superpowers/specs/2026-08-26-phase-0-lifecycle-and-inventory-design.md`.
PostgreSQL is authoritative for lifecycle classification, consent, deletion,
suppression, and restore-enforcement state.

The accountable policy owner is the Fast Cyber Defense Managing
Director/business-owner role. The owner must review this policy before production
launch and review active-client classifications at least annually.

Stored timestamps and retention calculations use UTC. Operator-facing displays
may render them in `Asia/Dhaka` (`UTC+06:00`), but display conversion must not
change an anchor or deadline.

## Classification And Precedence

Exactly one effective lifecycle class applies to a conversation identity at a
time. Precedence is:

`active_client > unconverted_lead > casual_chat`

Every classification change must append an audit event with the previous class,
new class, bounded reason code, actor type, and effective UTC timestamp. A
materialized current class may accelerate decisions, but the append-only history
is the authority for explaining reclassification.

A verified deletion overrides classification and retention deadlines. It must
not be reversed by later classification or restore activity.

Marketing consent is independent of lifecycle class. Consent does not extend
conversation retention, and a blank or absent consent value is always
promotional ineligibility.

## Qualifying And Excluded Events

A qualifying human-authored conversation event is either:

- an inbound customer message; or
- a proven human-agent or business reply correlated according to the approved
  channel behavior contract.

An event may qualify as a lead interaction only when it also has a documented
sales, quotation, consultation, or follow-up purpose.

The following events must not create or extend a lifecycle anchor:

- AI-generated replies;
- business templates sent without a customer response;
- message delivery, read, sent, or failed statuses;
- duplicates, retries, and replayed events;
- system, administrative, retention-job, or deletion-job activity;
- consent bookkeeping by itself;
- marketing sends without a customer response; and
- reactions without documented business meaning.

## Casual Chat Retention

- Period: 60 days.
- Anchor: the latest qualifying human-authored conversation event while the
  effective class is `casual_chat`.
- Deadline: `anchor + 60 * 24 hours` in UTC.
- Boundary: content becomes eligible for deletion when `now >= expires_at`.

The service must not use an AI response, provider status, duplicate, retry, or
administrative event as the casual-chat anchor.

## Unconverted Lead Retention

- Period: 12 calendar months.
- Anchor: the latest qualifying lead interaction while the effective class is
  `unconverted_lead`.
- Deadline: the same calendar day 12 months after the anchor, calculated in UTC.
- End-of-month rule: when the target month does not contain the anchor day, use
  the final day of the target month.
- Boundary: content becomes eligible for deletion when `now >= expires_at`.

The service must not extend lead retention from AI-only activity, a status
callback, a marketing send without a response, consent bookkeeping, a duplicate,
or a retry.

## Active Client Retention

- Period while active: the duration of the documented service relationship.
- Post-relationship period: 24 calendar months.
- Post-relationship anchor: the later of the documented relationship-end time or
  final paid service-completion time.
- Deadline: 24 calendar months after that anchor, using the unconverted-lead
  end-of-month rule.
- Boundary: content becomes eligible for deletion when `now >= expires_at`.

An `active_client` flag may not create indefinite retention. The policy owner
must review active classifications at least annually, and a review must record a
bounded outcome without storing conversation content in its evidence.

Accounting, contractual, security, or regulatory records requiring a different
period must be stored separately from support conversation content and governed
by a separately approved schedule.

## Reclassification Rules

- Promotion from `casual_chat` to `unconverted_lead` recalculates the deadline
  from the latest qualifying lead interaction.
- Conversion to `active_client` suspends automatic content expiry only while a
  current service relationship is documented.
- Relationship closure starts the 24-calendar-month post-relationship period.
- Downgrading a class must not resurrect deleted content.
- Downgrading must not manufacture a new anchor from an excluded event.
- A stale or out-of-order event may update delivery audit state as allowed by the
  webhook admission contract, but it must not move a retention anchor forward.
- A verified deletion remains terminal even if a later event is delivered for
  the same external identity.

## Deletion Verification

Deletion is a same-channel, human-reviewed workflow:

1. The customer requests deletion through the WhatsApp or Messenger identity
   associated with the data.
2. The service requests an explicit confirmation phrase or the name already
   associated with the conversation.
3. The service must never request a password, OTP, payment credential, access
   token, or other secret for deletion verification.
4. An authorized human reviewer confirms that the channel identity and request
   context are consistent. Ambiguous or disputed requests pause for manual
   resolution.
5. The reviewer records a bounded decision and reason code. Evidence must not
   contain customer content or an external identifier.

An authenticated LAN-only reviewer control may approve or reject the request.
The public webhook must not expose reviewer controls.

## Idempotent Deletion Execution

A deletion command must be idempotent. Repeating an approved request must produce
the same final state without recreating content or duplicating side effects.

The durable request record contains only the internal request reference,
reviewer reference, bounded decision/reason codes, decision time, execution
state, and content-free result counts.

An approved deletion removes applicable:

- live conversation messages and customer profile data;
- derived summaries, embeddings, and model artifacts;
- pending outbound work that could contact the identity;
- provider recordings that can be associated with the identity; and
- other customer-content copies governed by this service.

A separately governed record subject to a documented legal obligation may be
retained only with a reason code, policy-owner approval, access restriction, and
explicit expiry or review date.

## Suppression And Deletion Tombstones

The suppression store must not contain a raw external identity or message
content. `identity_hmac` is calculated over the canonical channel name and
canonical external identity with a dedicated, versioned HMAC key. That key must
not be reused for encryption, Meta signature verification, or another purpose.

The retained fields are limited to:

- `identity_hmac`;
- `channel`;
- `category`, either `marketing_opt_out` or `deletion_tombstone`;
- `reason_code`;
- `effective_at`;
- `key_version`; and
- `expires_at` when the category has a defined expiry.

A marketing opt-out remains effective until a later verified opt-in for the same
channel and category.

A deletion tombstone remains until 30 days after the newest backup that could
contain the deleted identity has expired. Key rotation must preserve matching for
all unexpired tombstones without retaining a raw identifier.

## Manifest Recording Rule

The dedicated Manifest harness is `fcd-support`, and application requests use
model `auto` with no tools.

Message-body recording must be disabled before customer or model traffic is
allowed through this harness. Manifest recordings are customer data for
retention and deletion purposes.

If recording cannot be disabled, bounded, and erased for a verified deletion,
the model path is a production no-go. OpenClaw and Hermes remain outside the
public customer-support execution path.

## Backup Restore Enforcement

Backups are immutable; they are not rewritten after every deletion. Restore
enforcement is therefore mandatory:

1. Restore into an isolated environment that cannot serve application traffic.
2. Load every unexpired deletion tombstone and the supported HMAC key versions.
3. Reapply deletions idempotently to live and derived records.
4. Verify affected records are absent using counts and bounded outcomes only.
5. Record the restore/deletion gate result without customer content or external
   identifiers.
6. Promote the restored database only after the gate passes.

A restored database must never be attached to the application before deletion
reapplication succeeds.

## Required Implementation Evidence

P3-005 retention tests must cover:

- every qualifying and excluded anchor event;
- exact 60-day and 12-calendar-month boundaries;
- month-end arithmetic;
- active relationship and 24-calendar-month post-relationship boundaries;
- precedence, promotion, closure, downgrade, duplicate, replay, and out-of-order
  behavior; and
- evidence that marketing consent and AI/system events do not extend retention.

P3-006 deletion tests must cover:

- same-channel confirmation and authorized human review;
- rejection of password, OTP, credential, and ambiguous verification paths;
- repeated and concurrent execution;
- live, derived, outbound, suppression, and tombstone effects;
- missing and blank consent remaining ineligible; and
- deleted identities remaining deleted after later events.

P6-004 backup tests must cover:

- isolated restore;
- all unexpired tombstone key versions;
- repeated reapplication;
- partial failure and retry;
- promotion refusal before the restore gate passes; and
- evidence that deleted content is not served after restore.

Dry-run and completion evidence is limited to counts, bounded reason codes,
timestamps, and Git revisions. It must never include customer content, raw
identities, hashes, payloads, recordings, prompts, or credentials.
