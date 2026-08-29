# Phase 3C Deletion Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement tracker row `P3-006` with verified, idempotent customer deletion, privacy-safe tombstones, pre-storage resurrection blocking, and isolated-restore reconciliation primitives.

**Architecture:** A dedicated privacy keyring creates domain-separated HMACs without exposing raw identities. PostgreSQL owns deletion requests, bounded reviewer decisions, suppressions, aggregate execution evidence, and restore gates. Receipt persistence checks tombstones before storing customer identifiers, while approved deletion pseudonymizes existing identifiers and clears governed content in one transaction.

**Tech Stack:** TypeScript 6 strict mode, Node.js 24, PostgreSQL 18, `pg` 8.22, `node-pg-migrate` 9, Zod 4, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-29-phase-3c-privacy-rights-design.md`

## Global Constraints

- Implement `P3-006` only. `REQUEST MY DATA`, `CORRECT MY DATA`, generalized phrase intake, and all-linked-identity `STOP MARKETING` remain `P3-007`.
- PostgreSQL remains authoritative; no in-memory deletion, consent, request, or restore state may become authoritative.
- Never commit, log, return, fixture, or place in evidence any live identity, message, credential, HMAC, payload, export, provider identifier, or customer data.
- Tests use only blank-authored synthetic identities and the guarded randomized-schema PostgreSQL harness.
- Passwords, OTPs, access tokens, payment credentials, and other secrets are invalid deletion verification evidence.
- Reviewer controls remain service methods only; do not add a public or private HTTP route in this plan.
- No Meta, Manifest, n8n, Cloudflare, Ubuntu, Docker, backup-file, or production-number action is in scope.
- `P6-004` owns backup creation/decryption/promotion; this plan provides only the database reconciliation and promotion-gate primitives it will call.
- All customer-data mutations and evidence insertion for one deletion execute in one bounded transaction.
- Evidence is restricted to internal references, timestamps, closed reason/outcome codes, aggregate counts, and Git revisions.

---

## File Structure

### Files Created

- `migrations/000004_create_deletion_safety.ts` — deletion request, evidence, suppression, and restore-gate schema plus database constraints/triggers.
- `src/policy/privacy-identity.ts` — canonical identity encoding and domain-separated HMAC functions.
- `src/policy/deletion-command.ts` — strict Zod schemas for open, review, execute, and restore commands.
- `src/persistence/postgres-deletion-policy.ts` — request creation, reviewer decision, local erasure, suppression checks, and aggregate evidence.
- `src/persistence/postgres-restore-deletion-gate.ts` — isolated restore reconciliation batches and final promotion decision.
- `tests/policy/privacy-identity.test.ts` — pure key and HMAC tests.
- `tests/policy/deletion-command.test.ts` — pure command validation tests.
- `tests/integration/postgres-deletion-policy.test.ts` — guarded request, review, execution, replay, concurrency, rollback, and resurrection tests.
- `tests/integration/postgres-restore-deletion-gate.test.ts` — guarded restore reapplication and promotion refusal tests.

### Files Modified

- `src/policy/policy-types.ts` — public deletion/keyring/result interfaces and `identity_suppressed` event outcome.
- `src/persistence/postgres-receipt-store.ts` — optional required privacy admission dependency and pre-storage tombstone handling.
- `src/persistence/postgres-conversation-event-processor.ts` — return the new already-suppressed outcome without creating policy state.
- `src/persistence/postgres-policy-helpers.ts` — internal subject-lock and content-free audit helpers shared by deletion services.
- `migrations/000004_create_deletion_safety.ts` replaces the existing generated application-outcome check in place; migration 000002 remains immutable.
- `tests/integration/policy-fixtures.ts` — one synthetic privacy keyring and deletion helper constructors.
- `tests/integration/migrations.test.ts` — migration 000004 apply/down/reapply and schema constraint coverage.
- `tests/integration/postgres-receipt-store.test.ts` — suppression-before-storage and retry coverage.
- `tests/integration/postgres-conversation-event-processor.test.ts` — suppressed events create no contact/conversation/retention state.
- Existing processor/store integration tests — inject the synthetic keyring through the shared fixture rather than duplicating secrets.
- `docs/architecture/data-lifecycle.md`, `docs/testing/acceptance-matrix.md`, `docs/security/threat-model.md`, `docs/TODO.md`, and `docs/PROJECT_CONTEXT.md` — truthful P3-006 behavior and evidence.

---

### Task 1: Privacy Identity Keyring And Command Contracts

**Files:**
- Create: `src/policy/privacy-identity.ts`
- Create: `src/policy/deletion-command.ts`
- Modify: `src/policy/policy-types.ts`
- Test: `tests/policy/privacy-identity.test.ts`
- Test: `tests/policy/deletion-command.test.ts`

**Interfaces:**
- Consumes: existing `ChannelIdentitySelector` and `ReviewerPrincipal` types.
- Produces:

```ts
export interface PrivacyHmacKey {
  readonly key: Buffer;
  readonly version: string;
}

export interface PrivacyHmacKeyring {
  readonly activeVersion: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface OpenDeletionRequestInput {
  readonly identity: ChannelIdentitySelector;
  readonly requestedAt: Date;
  readonly requestKey: string;
  readonly sourceWebhookEventId: string;
}

export interface ReviewDeletionRequestInput {
  readonly confirmationWebhookEventId: string;
  readonly decidedAt: Date;
  readonly decision: 'approve' | 'reject';
  readonly reasonCode: 'customer_confirmed' | 'identity_ambiguous' | 'request_withdrawn';
  readonly requestKey: string;
  readonly requestRef: string;
  readonly verificationMethod: 'explicit_confirmation' | 'known_name';
}

export interface ExecuteDeletionInput {
  readonly executedAt: Date;
  readonly requestKey: string;
  readonly requestRef: string;
}

export function createIdentityHmac(
  identity: ChannelIdentitySelector,
  key: PrivacyHmacKey,
): string;

export function createReplayHmac(idempotencyKey: string, key: PrivacyHmacKey): string;
export function requirePrivacyHmacKeyring(input: unknown): PrivacyHmacKeyring;
export function parseOpenDeletionRequestInput(input: unknown): OpenDeletionRequestInput;
export function parseReviewDeletionRequestInput(input: unknown): ReviewDeletionRequestInput;
export function parseExecuteDeletionInput(input: unknown): ExecuteDeletionInput;
```

- [ ] **Step 1: Write failing HMAC tests**

Create table-driven tests proving deterministic output, channel/account/contact separation, replay-domain separation, active-version lookup, minimum 32-byte keys, closed version syntax, and no raw identity substring in either digest.

```ts
const key = { key: Buffer.alloc(32, 0x31), version: 'TEST_v1' } as const;
const identity = {
  channel: 'whatsapp',
  channelAccountId: 'synthetic-account-a',
  externalContactId: 'synthetic-contact-a',
} as const;

expect(createIdentityHmac(identity, key)).toMatch(/^[0-9a-f]{64}$/);
expect(createIdentityHmac(identity, key)).toBe(createIdentityHmac(identity, key));
expect(createReplayHmac('synthetic-replay-key', key)).not.toBe(
  createIdentityHmac(identity, key),
);
```

- [ ] **Step 2: Run the HMAC test and verify RED**

Run: `npm test -- tests/policy/privacy-identity.test.ts`

Expected: FAIL because `privacy-identity.ts` does not exist.

- [ ] **Step 3: Implement canonical domain-separated HMACs**

Use length-prefixed UTF-8 fields so separators inside provider identifiers cannot create collisions:

```ts
function encode(parts: readonly string[]): Buffer {
  return Buffer.concat(
    parts.flatMap((part) => {
      const value = Buffer.from(part, 'utf8');
      const size = Buffer.allocUnsafe(4);
      size.writeUInt32BE(value.byteLength);
      return [size, value];
    }),
  );
}

export function createIdentityHmac(identity: ChannelIdentitySelector, key: PrivacyHmacKey): string {
  return createHmac('sha256', key.key)
    .update(encode(['fcd-support', 'deletion-identity', 'v1', identity.channel,
      identity.channelAccountId, identity.externalContactId]))
    .digest('hex');
}
```

`createReplayHmac` uses domain `deletion-replay` and the same length-prefixed encoding. Validate the keyring before any database connection.

- [ ] **Step 4: Write failing command-schema tests**

Cover strict-object rejection, invalid dates, numeric identifier strings, whitespace/length bounds, allowed reviewer decisions, and rejection of verification values such as `password`, `otp`, `access_token`, and `payment_credential`.

```ts
expect(() =>
  parseReviewDeletionRequestInput({
    ...validReview,
    verificationMethod: 'otp',
  }),
).toThrow();
```

- [ ] **Step 5: Implement the strict command schemas**

Use `z.strictObject`, `z.enum`, valid-date refinements, `/^\d+$/` for database identifiers, and bounded opaque keys/references of 1–128 trimmed characters. Do not accept free-form evidence or notes.

- [ ] **Step 6: Run unit tests and static checks**

Run: `npm test -- tests/policy/privacy-identity.test.ts tests/policy/deletion-command.test.ts`

Run: `npm run typecheck`

Expected: both test files and strict type checking PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/policy/privacy-identity.ts src/policy/deletion-command.ts src/policy/policy-types.ts tests/policy/privacy-identity.test.ts tests/policy/deletion-command.test.ts
git commit -m "feat: define deletion privacy contracts"
```

---

### Task 2: Deletion Safety Migration

**Files:**
- Create: `migrations/000004_create_deletion_safety.ts`
- Modify: `tests/integration/migrations.test.ts`

**Interfaces:**
- Consumes: `contacts`, `channel_identities`, `webhook_events`, and `webhook_event_applications` from migrations 000001–000003.
- Produces: `privacy_requests`, `privacy_request_events`, `privacy_request_locations`, `privacy_notification_intents`, `privacy_suppressions`, `privacy_deletion_runs`, and `restore_deletion_gates`.

- [ ] **Step 1: Write the failing migration-cycle test**

Extend the migration test to assert migration count `4`, roll back exactly one migration, confirm the seven tables disappear while Phase 3B tables remain, reapply, and inspect exact columns/check constraints/indexes.

```ts
await database.runMigrations('down', 1);
await expect(tableNames(database.pool)).resolves.not.toEqual(
  expect.arrayContaining(['privacy_requests', 'privacy_suppressions']),
);
await database.runMigrations('up');
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `npm run test:integration -- tests/integration/migrations.test.ts`

Expected: FAIL because migration 000004 and its tables do not exist.

- [ ] **Step 3: Create the bounded schema**

The migration must enforce these shapes:

```sql
create table privacy_requests (
  id bigint generated always as identity primary key,
  request_ref text not null unique,
  request_type text not null check (request_type in ('deletion', 'access', 'correction')),
  state text not null check (state in (
    'received', 'awaiting_confirmation', 'human_review', 'in_progress',
    'completed', 'partially_completed', 'rejected', 'cancelled'
  )),
  contact_id bigint references contacts(id) on delete set null,
  source_webhook_event_id bigint references webhook_events(id) on delete set null,
  received_at timestamptz not null,
  target_at timestamptz,
  decision_at timestamptz,
  completed_at timestamptz,
  reviewer_reference text,
  decision_code text,
  reason_code text,
  open_request_key text not null unique,
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0)
);

create table privacy_suppressions (
  id bigint generated always as identity primary key,
  identity_hmac text not null check (identity_hmac ~ '^[0-9a-f]{64}$'),
  channel text not null check (channel in ('messenger', 'whatsapp')),
  category text not null check (category in ('marketing_opt_out', 'deletion_tombstone')),
  reason_code text not null check (reason_code in ('customer_deletion', 'customer_opt_out')),
  effective_at timestamptz not null,
  key_version text not null,
  expires_at timestamptz,
  unique (identity_hmac, channel, category, key_version)
);
```

Use these exact evidence/workflow shapes; enum checks may be named constraints but must not be widened:

```sql
create table privacy_request_events (
  id bigint generated always as identity primary key,
  request_id bigint not null references privacy_requests(id),
  action text not null check (action in (
    'request_received', 'reviewer_decision', 'deletion_executed', 'location_checked'
  )),
  outcome text not null check (outcome in ('applied', 'rejected')),
  reason_code text not null check (reason_code in (
    'customer_requested', 'customer_confirmed', 'identity_ambiguous',
    'request_withdrawn', 'local_erasure_complete', 'location_complete',
    'location_not_applicable', 'location_failed'
  )),
  previous_state text,
  resulting_state text not null,
  actor_type text not null check (actor_type in (
    'customer', 'support_reviewer', 'deletion_job'
  )),
  reviewer_reference text,
  source_webhook_event_id bigint references webhook_events(id) on delete set null,
  effective_at timestamptz not null,
  request_key text not null unique,
  created_at timestamptz not null default now()
);

create table privacy_request_locations (
  request_id bigint not null references privacy_requests(id),
  location_code text not null check (location_code in (
    'primary_postgres', 'manifest_recordings', 'meta_provider',
    'pending_outbound', 'operator_exports', 'offline_archives',
    'backup_tombstone_gate'
  )),
  required boolean not null,
  state text not null check (state in (
    'pending', 'completed', 'not_applicable', 'failed'
  )),
  outcome_code text,
  reviewer_reference text,
  checked_at timestamptz,
  primary key (request_id, location_code)
);

create table privacy_notification_intents (
  id bigint generated always as identity primary key,
  request_id bigint not null references privacy_requests(id),
  notification_type text not null check (
    notification_type = 'operator_privacy_request'
  ),
  state text not null check (state in ('pending', 'delivered', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table privacy_deletion_runs (
  id bigint generated always as identity primary key,
  request_id bigint not null references privacy_requests(id),
  request_key text not null unique,
  executed_at timestamptz not null,
  conversations_processed integer not null check (conversations_processed >= 0),
  identities_pseudonymized integer not null check (identities_pseudonymized >= 0),
  messages_cleared integer not null check (messages_cleared >= 0),
  tombstones_created integer not null check (tombstones_created >= 0),
  status text not null check (status = 'applied'),
  completed_at timestamptz not null default now()
);

create table restore_deletion_gates (
  id bigint generated always as identity primary key,
  gate_ref text not null,
  request_key text not null unique,
  action text not null check (action in ('reapply_batch', 'finalize')),
  status text not null check (status in ('applied', 'failed', 'passed')),
  evaluated_at timestamptz not null,
  git_revision text not null check (git_revision ~ '^[0-9a-f]{40}$'),
  required_key_versions text[] not null,
  identities_processed integer not null check (identities_processed >= 0),
  remaining_matches integer not null check (remaining_matches >= 0),
  completed_at timestamptz not null default now()
);
```

Add the `privacy_suppressions` definition shown above between request locations
and deletion runs. Add an append-only trigger to request events, deletion runs,
and restore-gate rows. Add a request transition trigger that refuses
`completed` while a required location is `pending` or `failed`. Add a partial
unique index permitting at most one `passed` finalize row per `gate_ref`.
Replace the existing application-outcome check so an `identity_suppressed`
application is permitted only with a null conversation.
Leave `target_at` null in P3-006; P8-001 must approve the applicable legal SLA
before any production deadline is populated or enforced.

- [ ] **Step 4: Add database rejection tests**

Attempt invalid request types/states, malformed HMACs, raw/free-form category values, duplicate request keys, mutation/deletion of evidence, completed request with unresolved required location, and passing restore gate with a nonzero remaining-match count. Assert SQLSTATE `23514` for check/trigger failures and `23505` for unique-key conflicts.

- [ ] **Step 5: Run migration tests and verify GREEN**

Run: `npm run test:integration -- tests/integration/migrations.test.ts`

Expected: migration apply, rejection, down, and reapply tests PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add migrations/000004_create_deletion_safety.ts tests/integration/migrations.test.ts
git commit -m "feat: add deletion safety schema"
```

---

### Task 3: Verified Deletion Request State Machine

**Files:**
- Create: `src/persistence/postgres-deletion-policy.ts`
- Modify: `src/persistence/postgres-policy-helpers.ts`
- Modify: `tests/integration/policy-fixtures.ts`
- Create: `tests/integration/postgres-deletion-policy.test.ts`

**Interfaces:**
- Consumes: Task 1 parsers/keyring, `requireSupportReviewer`, `withBoundedTransaction`, and authoritative applied customer events.
- Produces:

```ts
export type OpenDeletionRequestResult =
  | { readonly status: 'opened'; readonly requestRef: string }
  | { readonly status: 'duplicate'; readonly requestRef: string };

export type ReviewDeletionRequestResult = {
  readonly requestRef: string;
  readonly state: 'human_review' | 'rejected';
  readonly status: 'applied' | 'duplicate';
};

export class PostgresDeletionPolicy {
  public constructor(pool: pg.Pool, keyring: PrivacyHmacKeyring);
  public openRequest(input: unknown): Promise<OpenDeletionRequestResult>;
  public reviewRequest(input: unknown, principal: unknown): Promise<ReviewDeletionRequestResult>;
  public isIdentityDeleted(identity: unknown, evaluatedAt: Date): Promise<boolean>;
}
```

- [ ] **Step 1: Write failing open-request tests**

Use synthetic applied WhatsApp and Messenger customer events. Prove the source event resolves the exact identity/contact, the request starts in `awaiting_confirmation`, required location rows and one notification intent are inserted, exact replay returns the same request reference, changed-material key reuse conflicts, and a non-applied/cross-identity source is rejected.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:integration -- tests/integration/postgres-deletion-policy.test.ts`

Expected: FAIL because `PostgresDeletionPolicy` does not exist.

- [ ] **Step 3: Implement `openRequest` minimally**

Inside one bounded transaction:

1. take an advisory lock on `requestKey`;
2. resolve exact replay and reject material conflict;
3. lock the applied customer event, application, conversation, identity, and contact;
4. insert a UUID request reference without returning identity data;
5. insert the closed required-location registry rows;
6. append a `request_received` event; and
7. insert one `operator_privacy_request` notification intent.

Return only `status` and `requestRef`.

- [ ] **Step 4: Write failing reviewer-decision tests**

Cover explicit confirmation and known-name methods, same identity and channel, unauthorized reviewer, cross-channel event, pre-request event, invalid secret verification method, ambiguous rejection, exact replay, concurrent approvals, and rollback when history insertion is forced to fail.

```ts
await expect(policy.reviewRequest(validReview, supportReviewer)).resolves.toEqual({
  requestRef,
  state: 'human_review',
  status: 'applied',
});
await expect(policy.reviewRequest(validReview, { reviewerRef: 'x', roles: [] }))
  .rejects.toThrow(PolicyAuthorizationError);
```

- [ ] **Step 5: Implement `reviewRequest`**

Lock the request and both source events. Require the confirmation event to be an applied customer message from the same channel/account/external identity and not earlier than `received_at`. `approve` transitions `awaiting_confirmation` to `human_review`; `reject` transitions to `rejected`. Store only the enum method, decision/reason code, timestamps, and opaque reviewer reference.

- [ ] **Step 6: Run request tests and static checks**

Run: `npm run test:integration -- tests/integration/postgres-deletion-policy.test.ts`

Run: `npm run typecheck`

Expected: request, verification, replay, concurrency, rollback, and type checks PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/persistence/postgres-deletion-policy.ts src/persistence/postgres-policy-helpers.ts tests/integration/policy-fixtures.ts tests/integration/postgres-deletion-policy.test.ts
git commit -m "feat: add verified deletion requests"
```

---

### Task 4: Tombstone-Aware Receipt Persistence

**Files:**
- Modify: `src/persistence/postgres-receipt-store.ts`
- Modify: `src/persistence/postgres-conversation-event-processor.ts`
- Modify: `src/policy/policy-types.ts`
- Modify: `tests/integration/postgres-receipt-store.test.ts`
- Modify: `tests/integration/postgres-conversation-event-processor.test.ts`
- Modify: `tests/integration/policy-fixtures.ts`

**Interfaces:**
- Consumes: `PrivacyHmacKeyring`, `createIdentityHmac`, and `createReplayHmac`.
- Produces: suppressed receipts with `admission_outcome = 'suppressed'`, `reason_code = 'deletion_tombstone'`, no raw identity/message/provider fields, and an HMAC-derived idempotency key.

- [ ] **Step 1: Write failing pre-storage suppression tests**

Insert a synthetic deletion tombstone, then submit a receipt containing the raw synthetic identity. Assert the stored event has null `channel_account_id`, `contact_id`, `external_message_id`, `message_text`, and `message_status`; its idempotency key does not contain the source value; processing creates no contact/conversation/retention row; exact receipt retry is a duplicate/no-op.

- [ ] **Step 2: Run receipt and processor tests and verify RED**

Run: `npm run test:integration -- tests/integration/postgres-receipt-store.test.ts tests/integration/postgres-conversation-event-processor.test.ts`

Expected: FAIL because the store does not consult deletion tombstones.

- [ ] **Step 3: Inject the validated keyring into receipt persistence**

Change construction to:

```ts
export class PostgresReceiptStore {
  public constructor(
    private readonly pool: pg.Pool,
    private readonly privacyKeyring: PrivacyHmacKeyring,
  ) {}
}
```

Before the receipt/event insert, compute the identity HMAC under every supported key version and query an unexpired `deletion_tombstone`. If matched, transform the event in memory to a privacy-safe rejected record. Use `privacy:<active-version>:<replay-hmac>` for the stored idempotency key. Do not log or return the HMAC.

- [ ] **Step 4: Keep event processing side-effect free**

Teach processor selection that only `pending` events are processable. If `processEvent` receives a suppressed event directly, return `{ status: 'not_processable' }`. Extend the event outcome type only where migration constraints require it; do not create an application row for a non-pending suppressed event.

- [ ] **Step 5: Update existing fixtures and constructor call sites**

Add one `TEST_v1` 32-byte synthetic key to `policy-fixtures.ts`. Pass it to every test store; do not read an environment secret in tests. Confirm production runtime still does not instantiate the Phase 2 store without an explicit keyring before later deployment wiring.

- [ ] **Step 6: Run all durable-ingestion and policy integration tests**

Run: `npm run test:integration -- tests/integration/postgres-receipt-store.test.ts tests/integration/postgres-conversation-event-processor.test.ts tests/integration/postgres-retention-policy.test.ts tests/integration/postgres-retention-job.test.ts`

Expected: suppression cases and all existing retry/retention cases PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/persistence/postgres-receipt-store.ts src/persistence/postgres-conversation-event-processor.ts src/policy/policy-types.ts tests/integration/policy-fixtures.ts tests/integration/postgres-receipt-store.test.ts tests/integration/postgres-conversation-event-processor.test.ts
git commit -m "feat: block deleted identities before storage"
```

---

### Task 5: Idempotent Local Deletion Execution

**Files:**
- Modify: `src/persistence/postgres-deletion-policy.ts`
- Modify: `src/policy/policy-types.ts`
- Modify: `tests/integration/postgres-deletion-policy.test.ts`

**Interfaces:**
- Consumes: an approved `human_review` deletion request and Task 1 keyring.
- Produces:

```ts
export interface DeletionExecutionResult {
  readonly conversationsProcessed: number;
  readonly identitiesPseudonymized: number;
  readonly messagesCleared: number;
  readonly requestRef: string;
  readonly status: 'applied' | 'duplicate';
  readonly tombstonesCreated: number;
}

public executeApprovedRequest(input: unknown): Promise<DeletionExecutionResult>;
```

- [ ] **Step 1: Write the failing full-erasure test**

Create one contact with linked synthetic WhatsApp and Messenger identities, messages, pause/consent/audit/retention history. Approve deletion, execute, and assert:

- all linked message text, raw identity fields, external message IDs, and status values are null or pseudonymized;
- each raw channel identity is replaced with a random opaque `deleted:` value that cannot match provider input;
- stored event idempotency keys equal the domain-separated replay HMAC form;
- one tombstone per linked identity exists but its value is never returned;
- `isIdentityDeleted` returns true for both linked identities so the future Phase 5 outbox has an authoritative send-time deny check;
- identifying request references are null;
- content-free policy/audit history remains internally referential; and
- result keys are exactly the six fields in `DeletionExecutionResult`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:integration -- tests/integration/postgres-deletion-policy.test.ts`

Expected: FAIL because execution is not implemented.

- [ ] **Step 3: Implement one-transaction erasure**

`executeApprovedRequest` must:

1. validate input before connecting;
2. advisory-lock `requestKey`, then lock request/contact/identities in stable ID order;
3. reject non-approved request states;
4. create every identity tombstone using the active key version before mutation;
5. select subject event IDs through conversation applications;
6. replace their idempotency keys with `privacy:<version>:<replay-hmac>` and clear raw/provider/content columns;
7. clear all currently implemented derived/customer-content columns; the tombstone-backed `isIdentityDeleted` method is the required future-outbound deny boundary until Phase 5 creates its outbox;
8. replace channel-account/external-contact values with separate random opaque values;
9. null request contact/source references;
10. mark local checklist rows complete but leave provider/offline/backup rows unresolved;
11. insert aggregate `privacy_deletion_runs` evidence; and
12. move the request to `in_progress`, not `completed`, because manual locations remain.

- [ ] **Step 4: Add replay, concurrency, rollback, and guard tests**

Prove exact replay returns prior counts, changed-material key reuse conflicts, concurrent keys cannot execute twice, rejected/unconfirmed requests cannot execute, forced evidence failure rolls back every tombstone and mutation, and no returned/error/audit value contains synthetic raw identities or HMACs.

- [ ] **Step 5: Add later-event resurrection test**

After execution, deliver a new signed-normalized synthetic event for each deleted raw identity through `PostgresReceiptStore`. Assert it is stored only as suppressed metadata and no identity, contact, conversation, retention state, consent, or message is recreated. Assert `isIdentityDeleted` remains true for the future Phase 5 send-time gate.

- [ ] **Step 6: Run deletion and adjacent policy suites**

Run: `npm run test:integration -- tests/integration/postgres-deletion-policy.test.ts tests/integration/postgres-receipt-store.test.ts tests/integration/postgres-conversation-event-processor.test.ts tests/integration/postgres-consent-policy.test.ts tests/integration/postgres-retention-policy.test.ts tests/integration/postgres-retention-job.test.ts`

Expected: deletion and all existing consent/retention semantics PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/persistence/postgres-deletion-policy.ts src/policy/policy-types.ts tests/integration/postgres-deletion-policy.test.ts
git commit -m "feat: erase approved customer data safely"
```

---

### Task 6: Isolated Restore Reconciliation And Promotion Gate

**Files:**
- Create: `src/persistence/postgres-restore-deletion-gate.ts`
- Create: `tests/integration/postgres-restore-deletion-gate.test.ts`
- Modify: `src/policy/deletion-command.ts`
- Modify: `src/policy/policy-types.ts`

**Interfaces:**
- Consumes: restored database containing current externally loaded `privacy_suppressions`, supported keyring versions, and the internal erasure primitive from Task 5.
- Produces:

```ts
export interface RestoreDeletionBatchInput {
  readonly evaluatedAt: Date;
  readonly gateRef: string;
  readonly gitRevision: string;
  readonly limit: number;
  readonly requestKey: string;
  readonly requiredKeyVersions: readonly string[];
}

export interface RestoreDeletionBatchResult {
  readonly identitiesProcessed: number;
  readonly remainingMatches: number;
  readonly status: 'applied' | 'duplicate';
}

export class PostgresRestoreDeletionGate {
  public constructor(pool: pg.Pool, keyring: PrivacyHmacKeyring);
  public reapplyBatch(input: unknown): Promise<RestoreDeletionBatchResult>;
  public finalizeGate(input: unknown): Promise<{ readonly status: 'passed' }>;
}
```

- [ ] **Step 1: Write failing reconciliation tests**

Create a synthetic pre-deletion database state and inject current tombstones as P6-004 will do after restore. Cover one and multiple key versions, batch limit, stable order, exact replay, missing required key, partial failure, and repeated reapplication.

- [ ] **Step 2: Run the restore test and verify RED**

Run: `npm run test:integration -- tests/integration/postgres-restore-deletion-gate.test.ts`

Expected: FAIL because the restore gate service does not exist.

- [ ] **Step 3: Implement bounded reapplication**

Validate all required versions exist before connecting. Advisory-lock the request key and gate reference. Scan raw `channel_identities` in stable ID order with `for update skip locked`, compute each supported identity HMAC in memory, compare only inside the process to unexpired tombstones, and invoke the same erasure primitive as Task 5 for matches. Return aggregate counts only.

- [ ] **Step 4: Write failing promotion-refusal tests**

Prove `finalizeGate` rejects when any matching raw identity remains, a required key is absent, a batch/evidence row failed, or `remaining_matches <> 0`. Prove a passed gate is append-only, exact finalize replay is safe, and changed Git revision/request material conflicts.

- [ ] **Step 5: Implement final verification**

Perform a full content-free scan, insert a `passed` gate only when every condition succeeds, and return only `{ status: 'passed' }`. Do not attach, promote, or switch a database connection; P6-004 must use the persisted pass record as its later prerequisite.

- [ ] **Step 6: Run restore and migration suites**

Run: `npm run test:integration -- tests/integration/postgres-restore-deletion-gate.test.ts tests/integration/postgres-deletion-policy.test.ts tests/integration/migrations.test.ts`

Expected: restore reapplication, refusal, replay, rollback, and migration tests PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/persistence/postgres-restore-deletion-gate.ts src/policy/deletion-command.ts src/policy/policy-types.ts tests/integration/postgres-restore-deletion-gate.test.ts
git commit -m "feat: enforce deletion after database restore"
```

---

### Task 7: P3-006 Documentation, Evidence, And Full Validation

**Files:**
- Modify: `docs/architecture/data-lifecycle.md`
- Modify: `docs/testing/acceptance-matrix.md`
- Modify: `docs/security/threat-model.md`
- Modify: `docs/TODO.md`
- Modify: `docs/PROJECT_CONTEXT.md`

**Interfaces:**
- Consumes: named passing tests and Git revisions from Tasks 1–6.
- Produces: truthful P3-006 evidence while leaving P3-007 and P3-GATE uncompleted.

- [ ] **Step 1: Run focused unit and guarded integration suites**

Run: `npm test -- tests/policy/privacy-identity.test.ts tests/policy/deletion-command.test.ts`

Run the guarded files serially to avoid migration advisory-lock contention:

```powershell
npm run test:integration -- tests/integration/migrations.test.ts tests/integration/postgres-deletion-policy.test.ts tests/integration/postgres-restore-deletion-gate.test.ts
npm run test:integration -- tests/integration/postgres-receipt-store.test.ts tests/integration/postgres-conversation-event-processor.test.ts
npm run test:integration -- tests/integration/postgres-consent-policy.test.ts tests/integration/postgres-retention-policy.test.ts tests/integration/postgres-retention-job.test.ts tests/integration/postgres-takeover-policy.test.ts
```

Expected: every named file PASS with zero leftover randomized schemas and zero advisory locks.

- [ ] **Step 2: Run the complete local gate**

Run: `npm run check`

Expected: Phase 0 validator, Prettier, ESLint, strict type checking, local tests, and build all PASS.

- [ ] **Step 3: Run privacy and scope scans**

Run:

```powershell
rg -n "(EAA|EAAG|Bearer |-----BEGIN|password\s*=|token\s*=|api[_-]?key\s*=)" src migrations tests docs
rg -n "fetch\(|axios|undici|meta\.fastcyberdefense|graph\.facebook|cloudflared|n8n|manifest" src migrations tests
rg -n "DELETE MY DATA|REQUEST MY DATA|CORRECT MY DATA|STOP MARKETING" src migrations tests
```

Review every match. Expected: no secret/live value; no new network/deployment call; only deletion behavior is implemented; P3-007 phrases beyond deletion remain tests/docs only.

- [ ] **Step 4: Verify database hygiene**

Query only aggregate counts against the guarded test database:

```sql
select count(*) from information_schema.schemata where schema_name like 'test_%';
select count(*) from pg_locks where locktype = 'advisory';
```

Expected: both counts are zero after tests finish.

- [ ] **Step 5: Update canonical documentation**

Document exactly what passed, including that:

- P3-006 is locally complete after every named test passes;
- P3-007 access/correction/global opt-out remains pending;
- no provider/offline deletion or notification delivery occurred;
- no actual backup was created/restored/promoted;
- P6-004 and P3-GATE remain blocked by their documented dependencies; and
- `docs/PROJECT_CONTEXT.md` names P3-007 as the next unblocked local task.

- [ ] **Step 6: Run documentation and diff checks**

Run: `npm run format:check`

Run: `git diff --check`

Run: `git status --short`

Expected: formatting and diff checks PASS; status lists only intended Task 7 documentation before commit.

- [ ] **Step 7: Commit Task 7**

```bash
git add docs/architecture/data-lifecycle.md docs/testing/acceptance-matrix.md docs/security/threat-model.md docs/TODO.md docs/PROJECT_CONTEXT.md
git commit -m "docs: record deletion safety evidence"
```

- [ ] **Step 8: Verify and push the complete P3-006 sequence**

Run: `git log --oneline --decorate -8`

Run: `git status --short`

Run: `git rev-list --left-right --count main...origin/main`

After confirming the worktree is clean and commits are scoped, run:

```bash
git push origin main
```

Expected: GitHub contains every P3-006 commit, the worktree is clean, and `main...origin/main` reports `0 0`. Do not pull or deploy the Ubuntu server in this task.

---

## P3-006 Completion Gate

P3-006 may be marked complete only when all of the following are true:

1. exact and concurrent request/reviewer/execution replays are idempotent;
2. secret-based and cross-identity verification paths are rejected;
3. existing governed content and raw identity fields are erased or pseudonymized;
4. receipt persistence prevents a deleted identity from being stored again;
5. suppression and evidence contain no raw identifiers or message content;
6. restore reconciliation supports every unexpired tombstone key version and
   refuses a pass with any remaining match or failure;
7. the full local and guarded PostgreSQL gates pass cleanly;
8. privacy/scope scans are reviewed and database test hygiene is clean;
9. documentation explicitly leaves provider/offline actions, P3-007, P6-004,
   deployment, Meta, and production work unclaimed; and
10. commits are pushed to GitHub with a clean synchronized worktree.
