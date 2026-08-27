# Phase 3B Retention Classification And Boundary Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement P3-005 retention classification, UTC deadlines, immutable lifecycle evidence, and idempotent bounded content-expiry jobs.

**Architecture:** Pure TypeScript functions calculate policy deadlines. PostgreSQL stores one locked current state per conversation plus append-only lifecycle history. Customer-message application updates casual state in the same transaction; authorized commands handle lead/human-reply and active-client transitions; a separate bounded job clears expired message content and records aggregate evidence.

**Tech Stack:** Node.js 24, TypeScript 6 strict mode, PostgreSQL 18, `pg`, `node-pg-migrate`, Zod 4, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-27-phase-3b-retention-design.md`

## Global Constraints

- Canonical lifecycle behavior is `docs/architecture/data-lifecycle.md`.
- PostgreSQL remains authoritative; no n8n state ownership is added.
- Store and calculate timestamps in UTC; `Asia/Dhaka` is display-only.
- Precedence is `active_client > unconverted_lead > casual_chat`.
- Models receive no tools, and no model or provider integration is added.
- Status, unproven echo, AI/system, consent, duplicate, replay, and out-of-order activity do not extend retention.
- Fixtures and evidence follow `docs/SYNTHETIC_FIXTURE_POLICY.md` and contain no live data or secrets.
- P3-006 deletion, suppression, tombstone, restore, public route, deployment, Meta, Cloudflare, and production-number work remains out of scope.

---

### Task 1: Add Strict UTC Deadline And Command Contracts

**Files:**
- Create: `src/policy/retention-deadline.ts`
- Create: `src/policy/retention-command.ts`
- Create: `tests/policy/retention-deadline.test.ts`
- Create: `tests/policy/retention-command.test.ts`
- Modify: `src/policy/policy-types.ts`
- Modify: `src/policy/reviewer-principal.ts`
- Modify: `tests/policy/reviewer-principal.test.ts`

**Interfaces:**

```typescript
export type LifecycleClass = 'active_client' | 'casual_chat' | 'unconverted_lead';

export function calculateCasualChatExpiry(anchor: Date): Date;
export function addUtcCalendarMonths(anchor: Date, months: 12 | 24): Date;
export function calculateClosedActiveClientDeadline(input: {
  readonly relationshipEndedAt?: Date;
  readonly finalPaidServiceCompletedAt?: Date;
}): { readonly anchorAt: Date; readonly expiresAt: Date };

export interface QualifyingRetentionEventInput {
  readonly conversationId: string;
  readonly sourceWebhookEventId: string;
  readonly targetClass: 'casual_chat' | 'unconverted_lead';
  readonly requestKey: string;
}

export interface ActiveRelationshipStartInput {
  readonly conversationId: string;
  readonly relationshipStartedAt: Date;
  readonly effectiveAt: Date;
  readonly requestKey: string;
}

export interface ActiveRelationshipReviewInput {
  readonly conversationId: string;
  readonly reviewedAt: Date;
  readonly requestKey: string;
}

export interface ActiveRelationshipCloseInput {
  readonly conversationId: string;
  readonly relationshipEndedAt?: Date;
  readonly finalPaidServiceCompletedAt?: Date;
  readonly effectiveAt: Date;
  readonly requestKey: string;
}

export interface RetentionReclassificationInput {
  readonly conversationId: string;
  readonly targetClass: 'casual_chat' | 'unconverted_lead';
  readonly effectiveAt: Date;
  readonly requestKey: string;
}

export function requirePolicyOwner(input: unknown): ReviewerPrincipal;
```

- [ ] **Step 1: Write failing deadline tests**

Add literal expectations for:

```typescript
expect(calculateCasualChatExpiry(new Date('2026-01-01T12:34:56.789Z'))).toEqual(
  new Date('2026-03-02T12:34:56.789Z'),
);
expect(addUtcCalendarMonths(new Date('2024-02-29T23:45:00.000Z'), 12)).toEqual(
  new Date('2025-02-28T23:45:00.000Z'),
);
expect(addUtcCalendarMonths(new Date('2026-01-31T08:00:00.000Z'), 12)).toEqual(
  new Date('2027-01-31T08:00:00.000Z'),
);
expect(addUtcCalendarMonths(new Date('2026-08-31T08:00:00.000Z'), 24)).toEqual(
  new Date('2028-08-31T08:00:00.000Z'),
);
```

Test invalid dates, missing active-client close anchors, later-anchor selection,
and preservation of UTC milliseconds.

Run: `npm test -- tests/policy/retention-deadline.test.ts`

Expected: FAIL because `retention-deadline.ts` does not exist.

- [ ] **Step 2: Implement minimal deadline functions**

Validate dates with `Number.isFinite(value.getTime())`. Calculate fixed days with
milliseconds. For calendar months, construct a UTC date at day 1 in the target
month, determine its final day with `Date.UTC(targetYear, targetMonth + 1, 0)`,
clamp the original UTC day, and preserve hour/minute/second/millisecond.

- [ ] **Step 3: Verify deadline tests pass**

Run: `npm test -- tests/policy/retention-deadline.test.ts`

Expected: all deadline tests PASS.

- [ ] **Step 4: Write failing parser and policy-owner tests**

Each command parser must reject nondecimal internal IDs, blank or over-128
request keys, invalid dates, unknown fields, unsupported target classes, and an
active close with neither close anchor. `requirePolicyOwner` must validate the
same strict principal shape as `requireSupportReviewer` and require the exact
`policy_owner` role without returning credential-shaped fields.

Run:

```powershell
npm test -- tests/policy/retention-command.test.ts tests/policy/reviewer-principal.test.ts
```

Expected: FAIL because retention parsers and `requirePolicyOwner` do not exist.

- [ ] **Step 5: Implement parsers, closed types, and policy-owner authorization**

Use `z.strictObject` and discriminated command schemas. Export parse functions
whose return values use the interfaces above. Keep principal authorization ahead
of database access.

- [ ] **Step 6: Verify and commit Task 1**

Run:

```powershell
npm test -- tests/policy/retention-deadline.test.ts tests/policy/retention-command.test.ts tests/policy/reviewer-principal.test.ts
npm run typecheck
npm run lint
git diff --check
```

Commit: `feat: define retention policy contracts`

### Task 2: Add Authoritative Retention Schema

**Files:**
- Create: `migrations/000003_create_retention_policy.ts`
- Modify: `tests/integration/migrations.test.ts`

**Interfaces:**

- Produces: `conversation_retention_states` keyed by `conversation_id`.
- Produces: `retention_events` keyed by generated `id`, with unique
  `request_key`.
- Produces: `retention_job_runs` keyed by generated `id`, with unique
  `request_key`.

`conversation_retention_states` must contain `conversation_id`,
`lifecycle_class`, `anchor_at`, `expires_at`, `relationship_status`,
`relationship_started_at`, `relationship_ended_at`,
`final_paid_service_completed_at`, `last_active_review_at`,
`next_active_review_at`, `content_purged_through_at`, `updated_at`, and
`row_version`.

`retention_events` must contain bounded `decision_type`, `outcome`,
`reason_code`, `actor_type`, and `source_type` values plus previous/resulting
class, effective/anchor/deadline times, optional internal source event and opaque
reviewer reference, and a unique nonblank request key.

`retention_job_runs` must contain request key, evaluated time, requested limit,
status, processed conversation count, purged message count, and completion time.

- [ ] **Step 1: Write failing migration table and constraint tests**

Extend the expected table list and add cases that reject:

- invalid lifecycle class, relationship state, outcome, reason, actor, or source;
- casual/lead state without anchor and deadline;
- open active state with an automatic deadline;
- closed active state without an anchor/deadline;
- deadlines not later than anchors;
- blank/duplicate request keys; and
- mutation or deletion of retention history/job evidence.

Run: `npm run test:integration -- tests/integration/migrations.test.ts`

Expected: FAIL because migration 000003 and its tables do not exist.

- [ ] **Step 2: Implement migration and indexes**

Add checks that encode the state combinations from the design. Add indexes on
`(expires_at, conversation_id)` for due non-null deadlines and on
`(next_active_review_at, conversation_id)` for open active relationships. Add an
append-only trigger shared by `retention_events` and `retention_job_runs`.

- [ ] **Step 3: Add rollback/reapply coverage**

The migration test must migrate down one step, prove all three tables are gone,
migrate up one step, and prove their constraints work again. It must use the
suite's randomized schema only.

- [ ] **Step 4: Verify and commit Task 2**

Run:

```powershell
npm run test:integration -- tests/integration/migrations.test.ts
npm run typecheck
npm run lint
git diff --check
```

Commit: `feat: add retention policy schema`

### Task 3: Apply Casual Retention Atomically With Customer Events

**Files:**
- Create: `src/persistence/postgres-retention-policy.ts`
- Modify: `src/persistence/postgres-conversation-event-processor.ts`
- Modify: `tests/integration/postgres-conversation-event-processor.test.ts`

**Interfaces:**

```typescript
export interface AppliedCustomerRetentionInput {
  readonly conversationId: string;
  readonly occurredAt: Date;
  readonly webhookEventId: string;
}

export async function applyCustomerMessageRetention(
  client: pg.PoolClient,
  input: AppliedCustomerRetentionInput,
): Promise<void>;
```

- [ ] **Step 1: Write the failing first-message and 60-day boundary tests**

Process a synthetic customer message at `2026-01-01T12:34:56.789Z`. Assert one
state row with `casual_chat`, the exact source timestamp as anchor, and
`2026-03-02T12:34:56.789Z` as deadline. Assert one bounded history row and no
message text in new lifecycle tables.

Run:

```powershell
npm run test:integration -- tests/integration/postgres-conversation-event-processor.test.ts
```

Expected: FAIL because event application does not create retention state.

- [ ] **Step 2: Implement same-transaction casual initialization**

After inserting `customer_message_applied`, lock the retention state. Insert
casual state/history when missing. Use request key
`customer-webhook-event:<internal event id>`. Any retention failure must roll
back application, identity, conversation, and audit rows.

- [ ] **Step 3: Write failing extension/exclusion/order tests**

Prove:

- a newer customer event advances casual anchor/deadline;
- an older or equal provider-time customer event records ignored history and
  cannot move the anchor;
- exact event replay and eight concurrent calls produce one retention decision;
- status events and unproven business echoes do not create or extend state;
- consent grant/revoke does not change state; and
- after an already-purged boundary, a late event at or before that boundary has
  its `message_text` cleared and cannot move the anchor.

- [ ] **Step 4: Implement ordering, precedence, and no-resurrection rules**

For existing casual state, update only when `occurredAt > anchor_at`. For lead or
active state, append an ignored decision with reason
`higher_precedence_preserved`. When `occurredAt <= content_purged_through_at`,
clear that webhook row's `message_text` in the same transaction and use reason
`purged_boundary_preserved`.

- [ ] **Step 5: Verify rollback and commit Task 3**

Use a schema-local synthetic trigger that rejects `retention_events` insertion
with SQLSTATE `P0001`; assert the customer application and all created policy
state roll back. Remove the trigger/function in `finally`.

Run:

```powershell
npm run test:integration -- tests/integration/postgres-conversation-event-processor.test.ts
npm run typecheck
npm run lint
git diff --check
```

Commit: `feat: anchor casual retention to customer events`

### Task 4: Implement Authorized Lead And Active-Client Transitions

**Files:**
- Modify: `src/persistence/postgres-retention-policy.ts`
- Create: `tests/integration/postgres-retention-policy.test.ts`

**Interfaces:**

```typescript
export type RetentionMutationResult =
  | { readonly status: 'applied'; readonly retentionEventId: string }
  | { readonly status: 'duplicate'; readonly retentionEventId: string }
  | { readonly status: 'ignored'; readonly retentionEventId: string };

export class PostgresRetentionPolicy {
  public constructor(private readonly pool: pg.Pool) {}
  public recordQualifyingEvent(input: unknown, principal: unknown): Promise<RetentionMutationResult>;
  public startActiveRelationship(input: unknown, principal: unknown): Promise<RetentionMutationResult>;
  public reviewActiveRelationship(input: unknown, principal: unknown): Promise<RetentionMutationResult>;
  public closeActiveRelationship(input: unknown, principal: unknown): Promise<RetentionMutationResult>;
  public reclassifyFromHistory(input: unknown, principal: unknown): Promise<RetentionMutationResult>;
}
```

- [ ] **Step 1: Write failing lead-purpose and proven-human tests**

Use applied synthetic customer and business-echo events. Prove a support reviewer
can mark either as `unconverted_lead` only when the source application maps to
the same conversation and source time. Assert exact 12-month month-end deadline,
promotion from casual, extension from a newer documented lead event, and no
extension from an older event.

Reject status, unsupported, unapplied, other-conversation, and mismatched-time
sources. An unreviewed echo must not change retention.

- [ ] **Step 2: Implement source verification and lead precedence**

Authorize before opening a database transaction. Lock the conversation/state,
join the source event to its application, and derive `effective_at` only from the
stored provider timestamp. Promote casual to lead or advance lead. Preserve
active state with an ignored bounded outcome.

- [ ] **Step 3: Write failing active lifecycle tests**

Prove:

- only `policy_owner` can start/review/close active relationships;
- start changes any lower class to open active, clears content expiry, and sets
  review due exactly 12 calendar months after the effective review/start time;
- continue review advances only the next annual review boundary;
- close chooses the later relationship-end/service-completion anchor and expires
  exactly 24 calendar months later with month-end clamping;
- exact replay is duplicate; request-key material conflict changes nothing; and
- lead/casual events cannot displace active precedence.

- [ ] **Step 4: Implement active start, annual review, and close**

Use `requirePolicyOwner` before transaction acquisition. Store only the opaque
reviewer reference. Do not store roles, free-form evidence, service content, or
external identity. Every command updates state and appends history atomically.

- [ ] **Step 5: Write failing downgrade/no-resurrection tests**

Create both casual and lead qualifying history, promote to active, purge through
one older boundary, then reclassify. The command must select the newest
qualifying target-class anchor strictly newer than `content_purged_through_at`.
Reject when no such anchor exists. Assert no `message_text` becomes non-null.

- [ ] **Step 6: Implement history-backed reclassification**

Require `policy_owner`. Select only applied qualifying history for the target
class, order by anchor descending then ID descending, and recalculate its class
deadline. Clear active relationship columns. Never copy or recreate content.

- [ ] **Step 7: Verify concurrency, rollback, and commit Task 4**

Prove eight concurrent exact commands yield one mutation, two conflicting keys
yield one success and one idempotency conflict, and a synthetic history-insert
failure rolls back state.

Run:

```powershell
npm run test:integration -- tests/integration/postgres-retention-policy.test.ts
npm test -- tests/policy/retention-command.test.ts tests/policy/reviewer-principal.test.ts
npm run typecheck
npm run lint
git diff --check
```

Commit: `feat: enforce retention classification transitions`

### Task 5: Implement Idempotent Expiry Boundary Batches

**Files:**
- Create: `src/persistence/postgres-retention-job.ts`
- Create: `tests/integration/postgres-retention-job.test.ts`
- Modify: `src/policy/policy-types.ts`

**Interfaces:**

```typescript
export interface RetentionJobInput {
  readonly evaluatedAt: Date;
  readonly limit: number;
  readonly requestKey: string;
}

export type RetentionJobResult = {
  readonly status: 'applied' | 'duplicate';
  readonly conversationsProcessed: number;
  readonly messagesPurged: number;
};

export class PostgresRetentionJob {
  public constructor(private readonly pool: pg.Pool) {}
  public runExpiredContentBatch(input: RetentionJobInput): Promise<RetentionJobResult>;
}
```

- [ ] **Step 1: Write failing exact boundary and preservation tests**

Seed two casual conversations with message text. At one millisecond before the
60-day deadline, assert zero processed/purged. At the exact deadline, assert the
due conversation's applied events through its anchor have `message_text = null`.
Assert lifecycle history, state, identity, conversation, consent, application,
pause, and audit rows remain.

Run: `npm run test:integration -- tests/integration/postgres-retention-job.test.ts`

Expected: FAIL because `PostgresRetentionJob` does not exist.

- [ ] **Step 2: Implement one bounded skip-locked batch**

Validate `limit` as an integer from 1 through 100, a valid date, and a trimmed
request key of 1 through 128 characters. In one bounded transaction:

```sql
select conversation_id, anchor_at
from conversation_retention_states
where expires_at <= $1
  and anchor_at is not null
  and (content_purged_through_at is null or anchor_at > content_purged_through_at)
order by expires_at, conversation_id
for update skip locked
limit $2
```

For each row, clear non-null `webhook_events.message_text` joined through
`webhook_event_applications` where `occurred_at <= anchor_at`, accumulate row
counts, advance `content_purged_through_at`, and insert one aggregate run row.

- [ ] **Step 3: Add lead, active, batch, replay, and concurrency tests**

Prove:

- 12-month lead and 24-month closed-active exact boundaries;
- open active relationships are never selected;
- limit partitions work in stable deadline/ID order;
- exact request replay returns prior counts without new effects;
- changed material under one request key throws idempotency conflict;
- different concurrent keys use `skip locked` and process each state at most once;
- a second fresh run after purge returns zero; and
- message rows newer than the authoritative anchor are not cleared.

- [ ] **Step 4: Add failure rollback and evidence-privacy tests**

Reject job-evidence insertion with a synthetic trigger and assert message text,
purged boundary, and run rows all roll back. Query `information_schema.columns`
and returned objects to prove job evidence has no identity, hash, message,
payload, prompt, token, URL, or free-form error column.

- [ ] **Step 5: Verify and commit Task 5**

Run:

```powershell
npm run test:integration -- tests/integration/postgres-retention-job.test.ts tests/integration/postgres-retention-policy.test.ts tests/integration/postgres-conversation-event-processor.test.ts
npm run typecheck
npm run lint
git diff --check
```

Commit: `feat: purge expired conversation content in bounded batches`

### Task 6: Verify P3-005 And Record Evidence

**Files:**
- Review: `migrations/000003_create_retention_policy.ts`
- Review: `src/persistence/postgres-conversation-event-processor.ts`
- Review: `src/persistence/postgres-retention-job.ts`
- Review: `src/persistence/postgres-retention-policy.ts`
- Review: `src/policy/policy-types.ts`
- Review: `src/policy/retention-command.ts`
- Review: `src/policy/retention-deadline.ts`
- Review: `src/policy/reviewer-principal.ts`
- Review: `tests/integration/migrations.test.ts`
- Review: `tests/integration/postgres-conversation-event-processor.test.ts`
- Review: `tests/integration/postgres-retention-job.test.ts`
- Review: `tests/integration/postgres-retention-policy.test.ts`
- Review: `tests/policy/retention-command.test.ts`
- Review: `tests/policy/retention-deadline.test.ts`
- Review: `tests/policy/reviewer-principal.test.ts`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: P3-005 unit and guarded PostgreSQL results.
- Produces: sanitized tracker evidence that completes only P3-005 and unblocks
  P3-006 without closing P3-GATE.

- [ ] **Step 1: Run complete local verification**

Run: `npm run check`

Expected: gate validation, formatting, lint, strict type checking, all unit tests,
and production build pass.

- [ ] **Step 2: Run complete guarded PostgreSQL verification**

Use only the approved `fcd_support_test` database and exact destructive-test
opt-in. Run `npm run test:integration` and record counts/status only. Do not print
the connection string or environment.

- [ ] **Step 3: Run scope, fixture, and privacy checks**

Run:

```powershell
git diff --check
rg -n "OpenClaw|Hermes|Manifest|OmniRoute|n8n|cloudflared" src migrations tests
rg -n "deletion_tombstone|identity_hmac|backup_restore|raw_payload|authorization" src migrations tests
git status --short
```

Review every match. Expected: no external integration, deletion/tombstone/restore
implementation, raw payload, credential, live identifier, or deployment change.

- [ ] **Step 4: Review every canonical evidence bullet**

Map every item under `P3-005 retention tests must cover` in
`docs/architecture/data-lifecycle.md` to a named passing test. Confirm no P3-006
behavior is claimed.

- [ ] **Step 5: Update tracker evidence**

Set P3-005 to `COMPLETE` with sanitized local and guarded PostgreSQL test counts.
Set P3-006 to `PENDING` because its P3-005 dependency is satisfied. Leave P3-GATE
blocked until P3-006 completes and the project owner reviews Phase 3.

- [ ] **Step 6: Commit, push, and verify synchronization**

Run:

```powershell
git diff --check
git add migrations/000003_create_retention_policy.ts `
  src/persistence/postgres-conversation-event-processor.ts `
  src/persistence/postgres-retention-job.ts `
  src/persistence/postgres-retention-policy.ts `
  src/policy/policy-types.ts src/policy/retention-command.ts `
  src/policy/retention-deadline.ts src/policy/reviewer-principal.ts `
  tests/integration/migrations.test.ts `
  tests/integration/postgres-conversation-event-processor.test.ts `
  tests/integration/postgres-retention-job.test.ts `
  tests/integration/postgres-retention-policy.test.ts `
  tests/policy/retention-command.test.ts `
  tests/policy/retention-deadline.test.ts `
  tests/policy/reviewer-principal.test.ts docs/TODO.md
git commit -m "docs: record retention policy evidence"
git push origin main
git status --short --branch
git rev-list --left-right --count main...origin/main
```

Expected: clean `main`, parity `0 0`, no Ubuntu pull or deployment.

## Plan Self-Review

- Every lifecycle-policy implementation bullet maps to a named task and test.
- All interfaces use closed values, internal IDs, opaque reviewer references, and
  bounded request keys.
- The automatic ingress path updates only casual retention from applied customer
  provider time.
- Reviewer-proven business replies and documented lead purpose are explicit;
  unproven echoes never extend retention.
- UTC fixed-day and calendar-month rules are independently unit tested.
- Current state is efficient for jobs while append-only history remains the
  explanatory authority.
- Exact boundaries, replay, concurrency, rollback, precedence, downgrade, and
  no-resurrection behavior have explicit tests.
- The boundary job clears only governed message content and records aggregate
  evidence; it does not implement verified deletion.
- No task deploys, opens a public route, calls Meta/Manifest/n8n, touches live
  data, or changes the production WhatsApp number.
