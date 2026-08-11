# Phase 3A Policy Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete tracker rows `P3-002` through `P3-004` with PostgreSQL-authoritative conversation identity, exactly-once event application, 24-hour human takeover, authorized resume, and append-only channel/category consent.

**Architecture:** Phase 2 `webhook_events` remain the durable input. A bounded transaction claims one pending event, resolves its channel-scoped identity, mutates one current conversation, appends policy history, and records one unique application. Separate takeover and consent services read and mutate the same PostgreSQL state; they do not cache eligibility. All public inputs are validated before SQL, all audit values come from closed unions, and no Phase 3A component adds HTTP routes, providers, models, n8n calls, retention behavior, deletion behavior, or live Meta access.

**Tech Stack:** Node.js 24, strict TypeScript 6, PostgreSQL 18, `pg` 8, `node-pg-migrate` 9, Zod 4, Vitest 4, ESLint 10, and Prettier 3.

## Global Constraints

- Implement only `P3-002`, `P3-003`, and `P3-004`. Leave `P3-005`, `P3-006`, and `P3-GATE` blocked.
- Use test-driven development: write the named failing test, run it and observe the stated failure, add the minimum production code, then rerun it.
- PostgreSQL is authoritative. Do not add in-memory pause, identity, application, or consent caches.
- Only Phase 2 rows with `admission_outcome = 'pending'` may produce Phase 3A state.
- Do not infer consent from message text. The consent service accepts only an already validated explicit command containing the exact approved wording and version.
- Do not add a public, tunnel, admin, or reviewer route. A future private authenticated transport may construct a `ReviewerPrincipal`; Phase 3A only enforces the supplied principal's role.
- Do not call Manifest, OmniRoute, n8n, Meta Graph, OpenClaw, Hermes, or any model. Models receive no tools.
- Do not implement outbound messages. Phase 5 must re-check the pause and consent policies in its send transaction and correlate service-generated echoes before applying the business-echo pause rule.
- Treat admitted Messenger business echoes as unmatched. Do not claim that the same behavior exists for WhatsApp coexistence or manual-app replies; that remains test-asset gated.
- Do not add retention classes, lifecycle jobs, deletion, suppression, backup replay, or recording cleanup.
- Use only obviously synthetic test identifiers and text. Never log or place message text, external identity, authorization material, raw payloads, or database URLs in audit rows.
- Windows `J:\DevDrive\fcd-support` is the only authoring, commit, and push checkout. Do not copy or edit source on Ubuntu. An Ubuntu pull is reserved for a separately approved test-deployment gate.
- Use the existing isolated PostgreSQL test service only through the approved local forward. Do not publish a PostgreSQL host port or alter unrelated server containers.
- Keep connection, lock, statement, and transaction timeouts bounded at the Phase 2 values.
- Each task ends in one independently reviewable commit. Push from Windows only after the task's named checks pass.

## File Responsibility Map

- `migrations/000002_create_policy_core.ts`: Phase 3A tables, constraints, indexes, and rollback order.
- `src/persistence/postgres-transaction.ts`: one reusable bounded transaction wrapper with safe rollback and connection disposal.
- `src/persistence/postgres-receipt-store.ts`: use the shared transaction wrapper without changing Phase 2 behavior.
- `src/policy/policy-types.ts`: closed channel selector, event-application, takeover, and consent result types.
- `src/policy/reviewer-principal.ts`: bounded principal validation and `support_reviewer` authorization.
- `src/policy/consent-command.ts`: exact explicit consent command validation; no message-text interpretation.
- `src/persistence/postgres-policy-helpers.ts`: transaction-local identity/conversation resolution and privacy-safe audit insertion.
- `src/persistence/postgres-conversation-event-processor.ts`: pending-event claim, exactly-once application, identity isolation, status ignore, and business-echo pause application.
- `src/persistence/postgres-takeover-policy.ts`: authoritative pause evaluation and idempotent authorized resume.
- `src/persistence/postgres-consent-policy.ts`: append-only grants/revocations and exact channel/category eligibility.
- `tests/policy/reviewer-principal.test.ts`: principal validation and role checks.
- `tests/policy/consent-command.test.ts`: bounded consent input validation and blank rejection.
- `tests/integration/policy-fixtures.ts`: synthetic Phase 2 receipt/event insertion and Phase 3A row-count helpers.
- `tests/integration/migrations.test.ts`: clean apply, constraints, rollback, and reapply for migration `000002`.
- `tests/integration/postgres-transaction.test.ts`: bounded transaction commit/rollback behavior.
- `tests/integration/postgres-conversation-event-processor.test.ts`: exactly-once state, separation, claims, concurrency, restart, privacy, and rollback.
- `tests/integration/postgres-takeover-policy.test.ts`: 24-hour boundary, duplicates, authorization, idempotent resume, and timestamp-ordered races.
- `tests/integration/postgres-consent-policy.test.ts`: blank/missing, grant, revoke, re-grant, duplicate, channel/category isolation, authorization, and tie-break behavior.
- `docs/TODO.md`: Phase 3A execution status and sanitized test evidence after all checks pass.

---

### Task 1: Add The Bounded Transaction Primitive

**Files:**
- Create: `src/persistence/postgres-transaction.ts`
- Modify: `src/persistence/postgres-receipt-store.ts`
- Create: `tests/integration/postgres-transaction.test.ts`

**Interfaces:**

```typescript
import type pg from 'pg';

export async function withBoundedTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T>;
```

The helper begins a transaction, applies `lock_timeout = '750ms'`, `statement_timeout = '3000ms'`, and `transaction_timeout = '3500ms'`, commits only after the operation resolves, rolls back on every thrown value, and destroys the checked-out client if rollback itself fails.

- [ ] **Step 1: Write the failing transaction tests**

Create `tests/integration/postgres-transaction.test.ts` with two tests:

1. insert a synthetic receipt inside `withBoundedTransaction` and prove it commits;
2. insert another receipt, throw `new Error('synthetic transaction failure')`, and prove the receipt count remains unchanged.

Use `createIsolatedTestDatabase('postgres_transaction')` and truncate only `webhook_receipts` with `cascade` in `beforeEach`.

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://fcd_support_test@127.0.0.1:55432/fcd_support_test'
$env:ALLOW_DESTRUCTIVE_DATABASE_TESTS='fcd-support-test-only'
npm run test:integration -- tests/integration/postgres-transaction.test.ts
```

Expected: FAIL because `src/persistence/postgres-transaction.ts` does not exist.

- [ ] **Step 2: Implement the transaction helper**

Use this control flow exactly:

```typescript
export async function withBoundedTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query('begin');
    await client.query(
      `set local lock_timeout = '750ms';
       set local statement_timeout = '3000ms';
       set local transaction_timeout = '3500ms'`,
    );
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
```

- [ ] **Step 3: Refactor Phase 2 to use the helper**

Move only transaction lifecycle and timeout handling out of `PostgresReceiptStore.store`. Its SQL, result shapes, stale/future decisions, and duplicate behavior must remain unchanged. The store calls:

```typescript
return withBoundedTransaction(this.pool, async (client) => {
  // Existing receipt and event SQL remains here.
});
```

- [ ] **Step 4: Verify the helper and Phase 2 regression boundary**

Run:

```powershell
npm run test:integration -- tests/integration/postgres-transaction.test.ts tests/integration/postgres-receipt-store.test.ts tests/integration/durable-runtime.test.ts
npm run typecheck
```

Expected: all selected integration tests and type checking pass.

- [ ] **Step 5: Format and commit**

Run:

```powershell
npm run format
git diff --check
git add src/persistence/postgres-transaction.ts src/persistence/postgres-receipt-store.ts tests/integration/postgres-transaction.test.ts
git commit -m "refactor: share bounded postgres transactions"
```

### Task 2: Create The Phase 3A Schema

**Files:**
- Create: `migrations/000002_create_policy_core.ts`
- Modify: `tests/integration/migrations.test.ts`

**Interfaces:**

Migration `000002` creates these exact tables and closed values:

```text
contacts
channel_identities.channel: whatsapp | messenger
conversations
webhook_event_applications.outcome:
  customer_message_applied | business_echo_paused |
  business_echo_ignored_before_resume | message_status_ignored
human_pause_events.action: pause | resume
human_pause_events.actor_kind: business_echo | reviewer
consent_events.action: grant | revoke
consent_events.source: customer_message | reviewer_recorded
policy_audit_outcomes.decision_type:
  event_application | reply_eligibility | authorized_resume |
  consent_record | marketing_eligibility
policy_audit_outcomes.outcome: allowed | denied | applied | duplicate | ignored
policy_audit_outcomes.reason_code:
  customer_message_applied | business_echo_pause | echo_not_later_than_resume |
  message_status_ignored | pause_active | pause_inactive | resume_applied |
  resume_duplicate | consent_grant | consent_revoke | consent_duplicate |
  consent_missing | consent_latest_grant | consent_latest_revoke |
  identity_not_found
```

- [ ] **Step 1: Write the failing migration inventory test**

Extend `tests/integration/migrations.test.ts` to expect these seven new table names in the active randomized schema:

```typescript
[
  'channel_identities',
  'consent_events',
  'contacts',
  'conversations',
  'human_pause_events',
  'policy_audit_outcomes',
  'webhook_event_applications',
]
```

Also update the rollback test to run `down` for two migrations, prove all Phase 2 and Phase 3A tables are absent, run `up`, and prove all nine tables return.

Run:

```powershell
npm run test:integration -- tests/integration/migrations.test.ts
```

Expected: FAIL because migration `000002` and its tables do not exist.

- [ ] **Step 2: Add contact, identity, conversation, and application tables**

Create `migrations/000002_create_policy_core.ts`. Use `bigint generated always as identity` primary keys, `timestamptz`, and explicit checks. The core DDL must encode:

```sql
create table contacts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table channel_identities (
  id bigint generated always as identity primary key,
  contact_id bigint not null references contacts(id),
  channel text not null check (channel in ('messenger', 'whatsapp')),
  channel_account_id text not null check (btrim(channel_account_id) <> ''),
  external_contact_id text not null check (btrim(external_contact_id) <> ''),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  unique (channel, channel_account_id, external_contact_id),
  check (last_seen_at >= first_seen_at)
);

create table conversations (
  id bigint generated always as identity primary key,
  channel_identity_id bigint not null unique references channel_identities(id),
  ai_paused_until timestamptz,
  last_authorized_resume_at timestamptz,
  created_at timestamptz not null,
  last_activity_at timestamptz not null,
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0)
);

create table webhook_event_applications (
  webhook_event_id bigint primary key references webhook_events(id),
  conversation_id bigint references conversations(id),
  outcome text not null check (outcome in (
    'customer_message_applied',
    'business_echo_paused',
    'business_echo_ignored_before_resume',
    'message_status_ignored'
  )),
  applied_at timestamptz not null default now()
);
```

Add a constraint requiring `conversation_id is null` only for `message_status_ignored`; all three message outcomes require a conversation.

- [ ] **Step 3: Add takeover, consent, and privacy-safe audit tables**

`human_pause_events` must use a unique nullable `source_webhook_event_id`, a unique nullable `reviewer_request_key`, and a shape constraint:

- a business-echo pause has a source event and deadline, with no reviewer fields;
- a reviewer resume has an opaque reviewer reference and request key, with no source event;
- `resulting_pause_until` may be non-null on a resume only when a later provider-time echo already exists and remains authoritative.

`consent_events` must require nonblank category, wording, wording version, and idempotency key; cap them at 64, 500, 64, and 128 characters respectively. Its shape constraint requires a source event for `customer_message` and prohibits one for `reviewer_recorded`.

`policy_audit_outcomes` stores only the closed values listed above plus nullable `conversation_id`, nullable `channel_identity_id`, nullable `related_webhook_event_id`, and `evaluated_at`. Do not add free-form detail, external ID, message, principal, authorization, request-body, or error columns.

Add these indexes:

```sql
create index human_pause_events_conversation_effective_idx
  on human_pause_events (conversation_id, effective_at desc, id desc);
create index consent_events_identity_category_latest_idx
  on consent_events (channel_identity_id, category, source_at desc, id desc);
create index policy_audit_conversation_evaluated_idx
  on policy_audit_outcomes (conversation_id, evaluated_at desc, id desc);
```

- [ ] **Step 4: Prove constraints and rollback**

Add migration tests that directly attempt and reject:

- a duplicate channel identity with SQLSTATE `23505`;
- a second application for one webhook event with SQLSTATE `23505`;
- an invalid channel, outcome, actor/action shape, audit reason, or consent source with SQLSTATE `23514`;
- blank category, wording, or wording version with SQLSTATE `23514`;
- a missing referenced event or identity with SQLSTATE `23503`.

The test inserts only synthetic IDs and the text `Synthetic approved consent wording`.

Run:

```powershell
npm run test:integration -- tests/integration/migrations.test.ts
```

Expected: all migration inventory, constraint, two-migration rollback, and reapply tests pass.

- [ ] **Step 5: Format and commit**

Run:

```powershell
npm run format
git diff --check
git add migrations/000002_create_policy_core.ts tests/integration/migrations.test.ts
git commit -m "feat: add Phase 3 policy schema"
```

### Task 3: Validate Policy Inputs And Closed Results

**Files:**
- Create: `src/policy/policy-types.ts`
- Create: `src/policy/reviewer-principal.ts`
- Create: `src/policy/consent-command.ts`
- Create: `tests/policy/reviewer-principal.test.ts`
- Create: `tests/policy/consent-command.test.ts`

**Interfaces:**

```typescript
export interface ChannelIdentitySelector {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly externalContactId: string;
}

export type EventApplicationOutcome =
  | 'business_echo_ignored_before_resume'
  | 'business_echo_paused'
  | 'customer_message_applied'
  | 'message_status_ignored';

export type EventProcessResult =
  | { readonly status: 'applied'; readonly eventId: string; readonly outcome: EventApplicationOutcome; readonly conversationId?: string }
  | { readonly status: 'already_applied'; readonly eventId: string; readonly outcome: EventApplicationOutcome; readonly conversationId?: string }
  | { readonly status: 'not_processable' }
  | { readonly status: 'no_pending_event' };

export interface ReviewerPrincipal {
  readonly reviewerRef: string;
  readonly roles: readonly string[];
}

export function requireSupportReviewer(input: unknown): ReviewerPrincipal;
export function parseConsentCommand(input: unknown): ConsentCommand;
```

`ConsentCommand` is a discriminated union. Both variants contain `identity`, `action`, `category`, `wording`, `wordingVersion`, `sourceAt`, and `idempotencyKey`. The customer variant contains `source: 'customer_message'` and a decimal `sourceWebhookEventId`. The reviewer variant contains `source: 'reviewer_recorded'` and no source event.

- [ ] **Step 1: Write failing principal tests**

Test that `requireSupportReviewer`:

- accepts an opaque `reviewerRef` of 1–128 trimmed characters with role `support_reviewer`;
- rejects a missing role, blank reference, reference over 128 characters, more than 16 roles, blank role, or unknown object field;
- never returns or stores an authorization header, token, or credential field.

Run:

```powershell
npm test -- tests/policy/reviewer-principal.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement strict principal validation**

Use a strict Zod object with `reviewerRef: z.string().trim().min(1).max(128)` and at most 16 nonblank roles of at most 64 characters. After parsing, require `roles.includes('support_reviewer')`; otherwise throw a stable `PolicyAuthorizationError` whose message is exactly `Support reviewer role required`.

- [ ] **Step 3: Write failing consent-command tests**

Test both source variants and reject:

- blank category, wording, wording version, identity fields, or idempotency key;
- a category outside `^[a-z0-9][a-z0-9._-]{0,63}$`;
- a wording longer than 500, version longer than 64, or idempotency key longer than 128;
- a non-Date or invalid Date `sourceAt`;
- a customer command without a decimal source event ID;
- a reviewer command with a source event ID;
- extra fields such as `messageText`, `authorization`, or `rawPayload`.

Use the valid synthetic category `security_updates` and wording `Synthetic approved consent wording`.

Run:

```powershell
npm test -- tests/policy/consent-command.test.ts
```

Expected: FAIL because the command parser does not exist.

- [ ] **Step 4: Implement the strict consent parser and result types**

Use strict Zod objects and this exact category expression:

```typescript
/^[a-z0-9][a-z0-9._-]{0,63}$/
```

Require identity account/external IDs to be trimmed, nonblank, and at most 255 characters. Require `idempotencyKey` to be trimmed, nonblank, at most 128 characters, and never derive it from wording or message text. Reject `Number.isNaN(sourceAt.getTime())` through Zod date validation.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npm test -- tests/policy/reviewer-principal.test.ts tests/policy/consent-command.test.ts
npm run typecheck
npm run format
git diff --check
git add src/policy tests/policy
git commit -m "feat: validate Phase 3 policy inputs"
```

### Task 4: Apply Pending Events Exactly Once

**Files:**
- Create: `src/persistence/postgres-policy-helpers.ts`
- Create: `src/persistence/postgres-conversation-event-processor.ts`
- Create: `tests/integration/policy-fixtures.ts`
- Create: `tests/integration/postgres-conversation-event-processor.test.ts`

**Interfaces:**

```typescript
export class PostgresConversationEventProcessor {
  public constructor(private readonly pool: pg.Pool) {}
  public processEvent(webhookEventId: string): Promise<EventProcessResult>;
  public processNext(): Promise<EventProcessResult>;
}
```

`processEvent` deterministically processes a named row for tests and recovery. `processNext` claims the oldest unapplied pending row by `(created_at, id)` using `FOR UPDATE OF webhook_events SKIP LOCKED`. Neither method starts a background loop.

- [ ] **Step 1: Create synthetic SQL fixtures and the first failing state test**

`tests/integration/policy-fixtures.ts` must expose parameterized helpers that insert one receipt and one pending event and return its decimal database ID. It must not log SQL parameters or database URLs.

Write the first processor test:

1. insert a pending synthetic Messenger customer event;
2. call `processEvent`;
3. expect one contact, one channel identity, one conversation, one event application, and one bounded audit row;
4. prove `webhook_events.message_text` remains only in the Phase 2 row and is absent from every Phase 3A table schema and selected audit row.

Run:

```powershell
npm run test:integration -- tests/integration/postgres-conversation-event-processor.test.ts
```

Expected: FAIL because the processor does not exist.

- [ ] **Step 2: Implement transaction-local identity and conversation resolution**

In `postgres-policy-helpers.ts`, add internal exported helpers that accept an existing `pg.PoolClient`.

Before selecting or inserting an identity, serialize the exact identity key with:

```sql
select pg_advisory_xact_lock(
  hashtextextended($1 || chr(31) || $2 || chr(31) || $3, 0)
)
```

Pass channel, channel account, and external contact as separate parameters. A hash collision may serialize unrelated work but cannot merge identities.

After the lock:

- select the exact `(channel, channel_account_id, external_contact_id)` identity;
- when missing, insert one contact and one identity in the same transaction;
- update `first_seen_at` with `least(first_seen_at, occurred_at)` and `last_seen_at` with `greatest(last_seen_at, occurred_at)`;
- insert the one current conversation or update `last_activity_at` with `greatest` and increment `row_version`;
- return string-form `identityId` and `conversationId` because `pg` returns PostgreSQL `bigint` as strings.

Add one audit helper whose TypeScript arguments are the same closed unions as the migration checks. The helper must not accept a free-form detail object.

- [ ] **Step 3: Implement locked event selection and customer/status outcomes**

`processEvent` selects the named event `for update`. Return `not_processable` without mutation when it is absent or not pending. After locking, check `webhook_event_applications`; an existing row returns `already_applied`.

`processNext` uses this query inside the same bounded transaction:

```sql
select webhook_events.*
from webhook_events
left join webhook_event_applications
  on webhook_event_applications.webhook_event_id = webhook_events.id
where webhook_events.admission_outcome = 'pending'
  and webhook_event_applications.webhook_event_id is null
order by webhook_events.created_at, webhook_events.id
for update of webhook_events skip locked
limit 1
```

For `customer_message`, require non-null channel/account/contact/time fields, resolve identity and conversation, then insert `customer_message_applied` and its audit row.

For `message_status`, insert `message_status_ignored` with a null conversation and its audit row. Phase 3A does not update delivery state.

If a pending row violates the Phase 2 normalized-field invariant, throw `InvalidPendingWebhookEventError`; the transaction must leave no application or policy state.

- [ ] **Step 4: Implement business-echo pause application in the same transaction**

For `business_message_echo`, resolve and lock the conversation, then compare `webhook_events.occurred_at` with `conversations.last_authorized_resume_at`.

- If `occurred_at <= last_authorized_resume_at`, do not change the conversation or append a pause history row. Record application outcome `business_echo_ignored_before_resume` and audit reason `echo_not_later_than_resume`.
- Otherwise calculate `occurred_at + interval '24 hours'`, set `ai_paused_until` to the later of that value and the existing deadline, increment `row_version`, append one `human_pause_events` row tied uniquely to the source event, and record `business_echo_paused` with reason `business_echo_pause`.

Do not inspect echo text and do not add outbound-correlation logic in Phase 3A.

- [ ] **Step 5: Add the exactly-once, isolation, claim, and restart tests**

Add tests proving:

- the same event processed twice creates one application and returns `already_applied` on replay;
- eight concurrent `processEvent` calls create one state transition;
- two external contact IDs that are textually identical but use different channel account IDs create separate contacts, identities, and conversations;
- WhatsApp and Messenger identities are separate even when their external ID text matches;
- `processNext` claims pending rows in stable order and skips stale/unsupported/already-applied rows;
- a new processor instance using the same pool returns the existing result after the first instance applied the event;
- a status event creates no contact, identity, or conversation;
- a database error while inserting the audit row rolls back contact, identity, conversation, pause, and application rows.

For the rollback test, create a schema-local trigger on `policy_audit_outcomes` whose function raises SQLSTATE `P0001`, run one processor call, assert rejection, remove the trigger/function in `finally`, and verify all Phase 3A state counts are zero. The trigger and exception text must be synthetic and must not contain event fields.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npm run test:integration -- tests/integration/postgres-conversation-event-processor.test.ts
npm run typecheck
npm run format
git diff --check
git add src/persistence/postgres-policy-helpers.ts src/persistence/postgres-conversation-event-processor.ts tests/integration/policy-fixtures.ts tests/integration/postgres-conversation-event-processor.test.ts
git commit -m "feat: apply conversation events exactly once"
```

### Task 5: Enforce Human Takeover And Timestamp-Ordered Resume

**Files:**
- Create: `src/persistence/postgres-takeover-policy.ts`
- Create: `tests/integration/postgres-takeover-policy.test.ts`
- Modify: `src/policy/policy-types.ts`

**Interfaces:**

```typescript
export interface ReplyEligibility {
  readonly eligible: boolean;
  readonly reason: 'pause_active' | 'pause_inactive';
}

export interface AuthorizedResumeInput {
  readonly conversationId: string;
  readonly effectiveAt: Date;
  readonly requestKey: string;
}

export type AuthorizedResumeResult =
  | { readonly status: 'applied'; readonly conversationId: string; readonly aiPausedUntil: Date | null }
  | { readonly status: 'duplicate'; readonly conversationId: string; readonly aiPausedUntil: Date | null };

export class PostgresTakeoverPolicy {
  public constructor(private readonly pool: pg.Pool) {}
  public evaluateReplyEligibility(conversationId: string, evaluatedAt: Date): Promise<ReplyEligibility>;
  public resume(input: AuthorizedResumeInput, principal: unknown): Promise<AuthorizedResumeResult>;
}
```

- [ ] **Step 1: Write the failing 24-hour boundary test**

Process a Messenger business echo at `2026-08-11T03:00:00.000Z`. Assert the stored deadline is exactly `2026-08-12T03:00:00.000Z`. Assert reply eligibility is denied one millisecond before the deadline and allowed at the exact deadline.

Run:

```powershell
npm run test:integration -- tests/integration/postgres-takeover-policy.test.ts
```

Expected: FAIL because the takeover policy does not exist.

- [ ] **Step 2: Implement authoritative reply eligibility**

Validate decimal conversation ID and valid `Date`. In one bounded transaction, select the conversation, compute active as `ai_paused_until > evaluatedAt`, and append one audit result:

- active: outcome `denied`, reason `pause_active`;
- null, expired, or exact deadline: outcome `allowed`, reason `pause_inactive`.

Do not return external identity or audit message content. Throw `PolicyRecordNotFoundError` for an unknown conversation.

- [ ] **Step 3: Write unauthorized and idempotent-resume tests**

Add tests proving:

- a missing `support_reviewer` role rejects before opening a transaction and leaves conversation, history, and audit counts unchanged;
- an authorized resume clears an existing pause, records the opaque reviewer reference but not roles or credentials, and sets `last_authorized_resume_at`;
- replaying the exact `requestKey` returns `duplicate` and creates no second history or audit mutation;
- reusing a request key with a different conversation, reviewer reference, or effective timestamp throws `PolicyIdempotencyConflictError` and changes nothing.

- [ ] **Step 4: Implement resume with provider-time race ordering**

Validate `requestKey` as trimmed, nonblank, and at most 128 characters. Authorize with `requireSupportReviewer` before obtaining a pool client.

Inside the transaction:

1. check an existing reviewer resume by request key and compare its conversation, reviewer reference, and effective timestamp;
2. lock the conversation `for update`;
3. set the authoritative resume cutoff to `greatest(existing last_authorized_resume_at, input.effectiveAt)`;
4. query business-echo pause rows joined to their source `webhook_events` and find the greatest pause deadline whose `occurred_at` is later than that cutoff;
5. set `last_authorized_resume_at` to the cutoff and `ai_paused_until` to that later-echo deadline or null;
6. increment `row_version`, append one reviewer resume history row, and append a `resume_applied` audit row.

This rule makes final state independent of lock acquisition order: an older echo cannot defeat resume, and a genuinely later provider-time echo remains or becomes active.

- [ ] **Step 5: Prove duplicates, extension, and both race orders**

Add tests proving:

- reprocessing the same echo cannot extend its deadline or append another pause row;
- a second distinct echo during an active pause extends only to the later of the existing deadline and its own `occurred_at + 24 hours`;
- resume and an older echo produce a resumed final state whether resume or echo commits first;
- resume and a later echo produce the later echo's pause deadline whether resume or echo commits first;
- an echo whose provider timestamp equals the resume cutoff does not re-pause;
- database unavailability returns no successful eligibility or resume result.

Implement both commit orders deterministically by holding the conversation row lock with a separate pool client, starting the competing promise, then releasing the lock. Keep the hold below the 750 ms lock timeout.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npm run test:integration -- tests/integration/postgres-takeover-policy.test.ts tests/integration/postgres-conversation-event-processor.test.ts
npm test -- tests/policy/reviewer-principal.test.ts
npm run typecheck
npm run format
git diff --check
git add src/persistence/postgres-takeover-policy.ts src/policy/policy-types.ts tests/integration/postgres-takeover-policy.test.ts
git commit -m "feat: enforce human takeover policy"
```

### Task 6: Enforce Append-Only Consent

**Files:**
- Create: `src/persistence/postgres-consent-policy.ts`
- Create: `tests/integration/postgres-consent-policy.test.ts`
- Modify: `src/policy/policy-types.ts`

**Interfaces:**

```typescript
export type ConsentRecordResult =
  | { readonly status: 'applied'; readonly consentEventId: string }
  | { readonly status: 'duplicate'; readonly consentEventId: string };

export interface MarketingEligibility {
  readonly eligible: boolean;
  readonly reason: 'consent_latest_grant' | 'consent_latest_revoke' | 'consent_missing' | 'identity_not_found';
}

export class PostgresConsentPolicy {
  public constructor(private readonly pool: pg.Pool) {}
  public recordCustomerCommand(input: unknown): Promise<ConsentRecordResult>;
  public recordReviewerCommand(input: unknown, principal: unknown): Promise<ConsentRecordResult>;
  public evaluateMarketingEligibility(
    identity: ChannelIdentitySelector,
    category: string,
    evaluatedAt: Date,
  ): Promise<MarketingEligibility>;
}
```

- [ ] **Step 1: Write failing missing/blank tests**

Create tests proving:

- an existing identity with no consent is ineligible with `consent_missing`;
- a selector for a nonexistent or other-channel identity is ineligible with `identity_not_found`;
- blank category evaluation returns ineligible without querying a consent row;
- blank category, wording, or wording version cannot create a grant or revoke.

Run:

```powershell
npm run test:integration -- tests/integration/postgres-consent-policy.test.ts
```

Expected: FAIL because the consent policy does not exist.

- [ ] **Step 2: Implement identity-scoped recording**

Parse every command with `parseConsentCommand`. For `recordReviewerCommand`, authorize with `requireSupportReviewer` before obtaining a database client. Reject a customer source passed to the reviewer method and a reviewer source passed to the customer method.

Inside one bounded transaction:

- resolve and lock the exact identity by channel, channel account, and external contact;
- for customer commands, require the source event application to map through its conversation to the same identity, require the source event kind to be `customer_message`, and require `sourceAt` to equal that event's `occurred_at` exactly;
- check `idempotency_key`; the exact same command returns `duplicate`, while any material mismatch throws `PolicyIdempotencyConflictError`;
- insert the immutable consent event and a `consent_record` audit row with `consent_grant` or `consent_revoke`.

Do not update or delete a prior consent row. Do not compare the approved wording with webhook message text.

- [ ] **Step 3: Implement latest-event eligibility**

Validate the selector, category, and `evaluatedAt`. A blank/invalid category returns false using reason `consent_missing`; it never broadens to another category.

Resolve the exact identity and select:

```sql
select action
from consent_events
where channel_identity_id = $1
  and category = $2
order by source_at desc, id desc
limit 1
```

Return eligible only for the latest `grant`. Record a bounded `marketing_eligibility` audit outcome: `allowed`/`consent_latest_grant`, `denied`/`consent_latest_revoke`, `denied`/`consent_missing`, or `denied`/`identity_not_found`.

- [ ] **Step 4: Add the complete consent matrix**

Prove:

- customer grant makes only the exact identity/channel/category eligible;
- revoke makes it ineligible immediately;
- a later re-grant restores eligibility;
- two events at the same `sourceAt` use the higher database ID as the winner;
- an older source-time event inserted later cannot override a newer event;
- exact duplicate commands append no second consent or audit row;
- idempotency-key reuse with changed action, identity, category, wording, wording version, source, source event, or source time fails without mutation;
- category and channel mismatch are false;
- one business account cannot consume consent granted under another account;
- unauthorized reviewer-recorded consent fails without mutation;
- a customer command cannot cite a business echo, status event, unapplied event, or another identity's customer event;
- audit rows contain no synthetic wording, webhook message text, external identity, reviewer role, or authorization detail;
- an audit insertion failure rolls back the consent row.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npm run test:integration -- tests/integration/postgres-consent-policy.test.ts
npm test -- tests/policy/consent-command.test.ts tests/policy/reviewer-principal.test.ts
npm run typecheck
npm run format
git diff --check
git add src/persistence/postgres-consent-policy.ts src/policy/policy-types.ts tests/integration/postgres-consent-policy.test.ts
git commit -m "feat: enforce append-only consent"
```

### Task 7: Verify Phase 3A And Record The Partial Gate

**Files:**
- Modify if required by failures: files introduced in Tasks 1–6 only
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: complete Phase 1, Phase 2, and Phase 3A test evidence.
- Produces: a sanitized tracker record that completes `P3-001` through `P3-004` while explicitly leaving retention/deletion and the full Phase 3 gate blocked.

- [ ] **Step 1: Run the complete local verification**

Run:

```powershell
npm run check
```

Expected: formatting, lint, strict type checking, all unit tests, and production build pass.

- [ ] **Step 2: Run the complete guarded PostgreSQL verification**

With the approved local forward to the isolated test-only database active, run:

```powershell
$env:TEST_DATABASE_URL='postgresql://fcd_support_test@127.0.0.1:55432/fcd_support_test'
$env:ALLOW_DESTRUCTIVE_DATABASE_TESTS='fcd-support-test-only'
npm run test:integration
```

Expected: every migration, Phase 2 durability, conversation, takeover, consent, concurrency, and rollback integration test passes in a randomized schema. Do not print the environment or add it to a file.

- [ ] **Step 3: Perform privacy and scope scans**

Run:

```powershell
rg -n "OpenClaw|Hermes|Manifest|OmniRoute|n8n|Graph API|cloudflared" src migrations tests
rg -n "retention_class|delete_customer|suppression|backup_restore|raw_payload|authorization" src migrations tests
rg -n "message_text|wording|reviewer_ref|external_contact_id" migrations/000002_create_policy_core.ts src/persistence tests/integration
git diff --check
```

Expected:

- the first two scans have no production-code integrations or lifecycle implementation;
- the third scan shows message text only in the existing Phase 2 event source and synthetic assertions, approved wording only in consent state, reviewer reference only in authorized resume history, and external identity only in the channel-identity table/query boundary;
- audit schema and insert helpers accept none of those sensitive/free-form values;
- the diff check is clean.

- [ ] **Step 4: Review the implementation against the approved design**

Confirm every case in the design's Test Strategy has a named passing test. Confirm no HTTP route, background worker loop, provider call, deployment file, public ingress, retention behavior, deletion behavior, or WhatsApp coexistence assumption was added.

If a correctness or security defect is found, fix it test-first in the smallest owning task file and rerun Steps 1–3. Do not expand scope to Phase 3B.

- [ ] **Step 5: Update the tracker without closing the full Phase 3 gate**

In `docs/TODO.md`:

- set `P3-001`, `P3-002`, `P3-003`, and `P3-004` to `COMPLETE` with the plan/spec paths and sanitized test counts;
- leave `P3-005` blocked by `P0-009` and `P0-010`;
- leave `P3-006` blocked by `P3-005`, `P0-011`, and `P0-012`;
- leave `P3-GATE` blocked;
- update Current Readiness to say the Phase 3A policy core is locally complete but Phase 3 as a whole is not complete.

Do not claim server deployment, Meta test-asset validation, WhatsApp coexistence, remote CI, retention, deletion, backup restore, or production readiness.

- [ ] **Step 6: Commit the evidence update**

Run:

```powershell
git diff --check
git status --short
git add docs/TODO.md
git commit -m "docs: record Phase 3A policy evidence"
git status --short --branch
```

Expected: the worktree is clean and the current branch contains only the planned Phase 3A commits. Push this Windows-authored branch/revision through the already approved repository workflow; do not pull it to Ubuntu until a separate test-deployment gate is approved.

## Plan Self-Review

- Every included tracker row (`P3-002` through `P3-004`) maps to schema, code, unit tests, real PostgreSQL tests, and final evidence.
- Every excluded row (`P3-005`, `P3-006`, and `P3-GATE`) remains blocked; no provisional retention or deletion decision is encoded.
- Identity uniqueness includes channel and business account, so textual external-ID collisions cannot merge customers.
- A transaction-scoped advisory lock prevents concurrent first-seen identity races without creating orphan contacts; the database unique constraint remains the final guard.
- Exactly-once application is protected by the source-event row lock and primary key on `webhook_event_applications.webhook_event_id`.
- Pending message statuses are deliberately recorded as ignored and create no conversation state.
- Human pause uses provider time plus 24 hours, is active only before its deadline, and cannot be extended by an exact replay.
- Resume/echo final state is based on timestamps rather than database lock order. Equal/older echoes lose to resume; later echoes win.
- Reviewer authorization is validated before database access, and only the opaque reviewer reference is stored.
- Consent is explicit, immutable, exact-identity/exact-channel/exact-category scoped, and false when absent or blank.
- Equal consent timestamps resolve by higher database ID; late insertion of an older event cannot override a newer source event.
- Idempotency-key reuse with different material is an error, not a silent mutation or false duplicate.
- Audit schemas and helpers accept only closed outcomes/reasons and internal foreign keys; no text, raw external identity, credentials, or free-form error detail is accepted.
- Failure injection proves that state, history, application, and audit changes roll back together.
- No task deploys to Ubuntu, opens DNS/tunnel paths, touches Meta assets, uses live data, or changes the production WhatsApp number.
