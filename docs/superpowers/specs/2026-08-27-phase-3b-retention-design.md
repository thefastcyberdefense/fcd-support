# Phase 3B Retention Classification And Boundary Jobs Design

## Status And Scope

This design implements tracker row `P3-005` against the canonical policy in
`docs/architecture/data-lifecycle.md`. It is approved for safe local development
by the project owner's direction to continue with the first unblocked task after
validating the Phase 0 gate.

The change is limited to retention classification, deadline calculation,
append-only lifecycle evidence, and bounded content-expiry jobs. It does not
implement verified customer deletion, suppression hashes, deletion tombstones,
backup restore enforcement, public routes, provider calls, notifications, or
deployment.

## Considered Approaches

1. **Materialized state plus append-only history (selected).** Keep one locked
   current row per conversation for safe boundary decisions, while every
   classification, anchor, relationship, and review decision is explained by an
   immutable history row. This gives efficient jobs without sacrificing audit
   authority.
2. **Derive all state from history.** This minimizes duplicated state but makes
   every boundary scan expensive and makes concurrent expiry decisions harder to
   lock safely.
3. **Store only class and deadline on `conversations`.** This is simple but cannot
   explain reclassification, prove excluded-event behavior, or enforce the
   append-only history required by policy.

## Architecture

### Pure Deadline Arithmetic

`src/policy/retention-deadline.ts` owns deterministic UTC calculations:

- casual chat: exactly `60 * 24` hours after its anchor;
- unconverted lead: 12 calendar months after its anchor;
- closed active client: 24 calendar months after the later of relationship end
  and final paid service completion; and
- calendar-month calculations clamp to the last valid UTC day of the target
  month while preserving the UTC time of day.

The functions accept and return `Date` values, reject invalid dates, and never
consult the host timezone.

### Authoritative PostgreSQL State

Migration `000003_create_retention_policy.ts` adds:

- `conversation_retention_states`: one current row per conversation containing
  lifecycle class, current anchor/deadline, active-relationship status and review
  deadline, the newest content boundary already purged, and a row version;
- `retention_events`: append-only bounded history containing previous/new class,
  decision type, outcome, reason, actor/source types, effective time, resulting
  anchor/deadline, optional authoritative webhook event, opaque reviewer
  reference, and a unique idempotency key; and
- `retention_job_runs`: content-free batch evidence containing request key,
  evaluated time, limit, status, and aggregate processed/purged counts.

Database checks constrain every enum-like value and state combination. Triggers
reject update/delete of lifecycle history and job evidence. Foreign keys use
internal IDs only; none of the new tables stores message text, consent wording,
raw external identities, payloads, credentials, or free-form evidence.

### Lifecycle Commands

`PostgresRetentionPolicy` exposes closed, validated commands:

- applied customer messages initialize or advance `casual_chat` automatically in
  the same transaction as event application;
- `recordQualifyingEvent` lets a support reviewer document a lead-purpose
  customer interaction or prove that an applied business echo was human-authored;
- `startActiveRelationship`, `reviewActiveRelationship`, and
  `closeActiveRelationship` require a `policy_owner` role;
- `reclassifyFromHistory` requires a policy owner and can downgrade only to an
  existing, unpurged qualifying anchor for the requested target class; and
- every reviewer command uses a bounded request key. Exact replay is duplicate;
  reuse with different material is an idempotency conflict.

Class precedence is `active_client > unconverted_lead > casual_chat`. A lead
interaction promotes casual state or advances lead state, but it cannot
implicitly downgrade active state. Starting an active relationship clears the
automatic content deadline while the relationship is open. Closing it uses the
later documented close/completion time plus 24 calendar months. Continuing the
required annual active-client review advances only the review deadline; it does
not manufacture a content anchor.

### Automatic Customer-Message Boundary

The conversation event processor calls a retention helper only after a
`customer_message` application has been inserted. The helper:

- creates casual state at the event's provider timestamp when no state exists;
- advances a casual anchor only for a strictly newer provider timestamp;
- does not advance lead or active state;
- records an ignored, bounded history decision for out-of-order or
  higher-precedence cases; and
- clears the current event's `message_text` when its timestamp is at or before a
  previously purged boundary, preventing late delivery from resurrecting expired
  content.

Status callbacks and business echoes do not call this helper. A business echo
can influence retention only through an authorized command that verifies the
existing event application and documents it as a human reply. Consent methods
do not call retention code.

### Boundary Job

`PostgresRetentionJob.runExpiredContentBatch` runs one bounded transaction per
invocation. It validates an evaluation time, request key, and a limit from 1 to
100, then:

1. serializes exact request-key replay with a transaction advisory lock;
2. returns the prior aggregate result for an exact replay and rejects changed
   material;
3. selects due state rows where `expires_at <= evaluatedAt` and the anchor is
   newer than the last purged boundary, using `for update skip locked`;
4. clears `webhook_events.message_text` only for events applied to each selected
   conversation at or before its authoritative anchor;
5. advances `content_purged_through_at` without deleting lifecycle history,
   consent, audit state, or external-identity state; and
6. records only aggregate counts and bounded status in `retention_job_runs`.

The exact deadline is eligible; one millisecond before it is not. Different job
keys can process disjoint locked rows concurrently. Repeating a completed key or
rerunning after a boundary has already been purged cannot duplicate effects.

## Failure And Concurrency Rules

- State and history changes share the caller's bounded database transaction.
- Row locks serialize competing lifecycle commands for one conversation.
- Unique request keys and authoritative webhook references enforce replay safety.
- A history or job-evidence insertion failure rolls back the whole operation.
- Out-of-order source timestamps never move an anchor forward.
- Purged content is never reconstructed; later genuinely new customer content
  can establish a new casual boundary when policy precedence permits it.
- The job returns counts only and never logs or returns identities or message
  content.

## Test Strategy

Unit tests cover exact 60-day arithmetic, 12- and 24-month month-end rules,
leap-day behavior, UTC time preservation, invalid input, and exact boundaries.

Guarded randomized-schema PostgreSQL tests cover:

- all three lifecycle classes and precedence;
- customer and reviewer-proven human qualifying events;
- every excluded source class: status, unproven echo, consent, duplicate, replay,
  and out-of-order activity;
- promotion, active start/review/closure, downgrade from existing history, and no
  resurrection across a purged boundary;
- exact due/not-due boundaries and month-end deadlines;
- batch limits, skip-locked concurrency, exact replay, idempotency conflict, and
  rollback on evidence failure;
- message content clearing with policy/audit/consent/identity state preserved;
  and
- migration apply, rollback, and reapply.

Fixtures are authored from blank synthetic templates under
`docs/SYNTHETIC_FIXTURE_POLICY.md`. Evidence contains counts, bounded outcomes,
timestamps, and Git revisions only.

## Approval Boundaries Preserved

This design authorizes local repository implementation and isolated guarded
database tests only. It does not authorize pulling to Ubuntu, deploying a new
revision, changing Cloudflare, changing Meta assets, touching live data, or
changing the production WhatsApp number.
