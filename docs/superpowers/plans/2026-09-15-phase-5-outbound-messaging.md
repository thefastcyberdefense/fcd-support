# Phase 5 Outbound Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox syntax (- [ ]) for tracking.

**Goal:** Build a PostgreSQL-authoritative, policy-gated outbound worker that
sends through fail-closed local Meta adapters without blind duplicate delivery.

**Architecture:** A transactional outbox creates one intent from a reviewed
reply draft or fixed template. A leased worker rechecks all policy, reserves
customizable rate capacity, records dispatch start, calls one channel adapter,
and records accepted, definitely rejected, unknown, or terminal outcomes.
Signed webhook statuses and Messenger echo holds reconcile external results
without making Meta, n8n, or process memory authoritative.

**Tech Stack:** TypeScript strict mode, Zod, Fastify-compatible fetch contracts,
node:crypto, PostgreSQL 16, node-postgres, node-pg-migrate, Vitest, Docker
Compose isolated PostgreSQL.

**Spec:** docs/superpowers/specs/2026-09-15-phase-5-outbound-messaging-design.md

## Global Constraints

- PostgreSQL remains authoritative for intents, attempts, limits, correlation,
  cancellation, and delivery projection.
- Graph API version is exactly v25.0; configuration has no operational defaults
  and rejects version drift.
- The documented support window is 2026-02-18 through 2028-07-29 and must be
  rechecked before live P7 use.
- Only WhatsApp text/fixed-template and Messenger text are supported.
- Fixed templates have zero variables. Media, message tags, quick replies,
  sender actions, and caller-supplied URLs/metadata are rejected.
- Models receive no tools and do not participate in provider delivery.
- Limits and retry timing are customizable through reviewed PostgreSQL policy
  intersected with required protected deployment bounds.
- A timeout, transport loss, malformed success, redirect, crash after
  dispatch_started, or other ambiguous outcome becomes delivery_unknown and is
  never automatically resent.
- Automatic retries require a closed definitely_rejected outcome and stop at
  the effective maximum.
- Enqueue and dispatch both recheck pause, echo hold, privacy, deletion,
  suppression, consent, service window, template state, erasure, and retention.
- n8n, Manifest, OpenClaw, and Hermes cannot enqueue, send, retry, or own
  outbound state.
- No live token, provider call, deployment, external mutation, customer data,
  or production asset is authorized by this plan.
- Every fixture follows docs/SYNTHETIC_FIXTURE_POLICY.md.
- Every completed task is formatted, tested, committed, and pushed to main.

---

## Task 1: Add the closed Phase 5 PostgreSQL schema

**Files:**

- Create: migrations/000012_create_outbound_messaging.ts
- Modify: tests/integration/migrations.test.ts
- Modify: tests/integration/postgres-restore-deletion-gate.test.ts

**Interfaces:**

- Consumes: migrations 000001 through 000011, support_reply_drafts,
  channel_identities, conversations, consent_events, privacy_suppressions.
- Produces: outbound policy/template history, intents, attempts, rate windows,
  statuses, echo holds, and escalation tables used by every later task.

- [x] **Step 1: Write the failing migration inventory test**

Add assertions that migration 000012 creates exactly these new tables:

~~~ts
const phase5Tables = [
  'outbound_policy_versions',
  'outbound_policy_review_events',
  'outbound_template_versions',
  'outbound_template_review_events',
  'outbound_intents',
  'outbound_attempts',
  'outbound_rate_windows',
  'outbound_status_events',
  'outbound_echo_correlation_holds',
  'outbound_escalation_outcomes',
] as const;
~~~

Assert closed check constraints, unique draft-to-intent, unique
channel/account/provider-message correlation, append-only history, and the
absence of columns named payload, request_body, response_body, token,
authorization, external_contact_id, or message_text in Phase 5 tables.

- [x] **Step 2: Write failing downgrade and impossible-state tests**

The empty schema must down/up cleanly. Any populated policy, template, intent,
attempt, status, hold, rate, or escalation table must make down fail before
mutation with SQLSTATE 55000. Add direct inserts that try invalid state/source,
accepted-without-provider-ID, dispatch-started-without-start-time,
terminal-without-finish-time, and cross-source intent shapes.

- [x] **Step 3: Run the focused migration tests and confirm failure**

Run:

~~~powershell
npm run test:integration -- tests/integration/migrations.test.ts tests/integration/postgres-restore-deletion-gate.test.ts
~~~

Expected: FAIL because migration 000012 and its tables do not exist.

- [x] **Step 4: Implement migration 000012**

Use explicit SQL with no operational defaults. Required core shapes:

~~~sql
create table outbound_policy_versions (
  id bigint generated always as identity primary key,
  policy_ref text not null unique,
  version_number integer not null,
  per_contact_15_minute integer not null,
  per_contact_24_hour integer not null,
  whatsapp_account_1_minute integer not null,
  messenger_account_1_minute integer not null,
  global_1_minute integer not null,
  global_utc_day integer not null,
  worker_batch_size integer not null,
  lease_ms integer not null,
  provider_timeout_ms integer not null,
  maximum_definite_retries integer not null,
  retry_base_ms integer not null,
  retry_maximum_ms integer not null,
  state text not null,
  created_at timestamptz not null,
  decided_at timestamptz,
  retired_at timestamptz,
  unique (version_number)
);

create table outbound_intents (
  id bigint generated always as identity primary key,
  intent_ref text not null unique,
  request_key text not null unique,
  reply_draft_id bigint unique references support_reply_drafts(id),
  template_version_id bigint references outbound_template_versions(id),
  conversation_id bigint not null references conversations(id),
  channel_identity_id bigint not null references channel_identities(id),
  policy_version_id bigint not null references outbound_policy_versions(id),
  channel text not null,
  purpose text not null,
  message_kind text not null,
  state text not null,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  lease_ref text,
  lease_expires_at timestamptz,
  retention_deadline timestamptz not null,
  terminal_reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  finished_at timestamptz
);
~~~

Add exact source/state consistency checks, ranges, references, partial indexes,
append-only triggers, controlled intent/attempt/hold transition triggers, and a
populated downgrade guard. Extend restore-location schema checks so
pending_outbound remains a required deletion location.

- [x] **Step 5: Run migration tests**

Run the command from Step 3.

Expected: PASS with all twelve migrations applied, guarded down refusal, clean
empty down/up, and zero leftover test schemas/advisory locks.

- [x] **Step 6: Run task validation and checkpoint**

Run:

~~~powershell
npm run typecheck
npm run format:check
git diff --check
~~~

Commit and push:

~~~powershell
git add migrations/000012_create_outbound_messaging.ts tests/integration/migrations.test.ts tests/integration/postgres-restore-deletion-gate.test.ts
git commit -m "feat: add phase 5 outbound schema"
git push origin main
~~~

## Task 2: Define outbound contracts and fail-closed configuration

**Files:**

- Create: src/outbound/outbound-types.ts
- Create: src/outbound/outbound-policy-input.ts
- Create: src/outbound/outbound-config.ts
- Create: tests/outbound-policy-input.test.ts
- Create: tests/outbound-config.test.ts
- Modify: .env.example

**Interfaces:**

- Consumes: closed channel/language/purpose values and environment input.
- Produces: OutboundPolicyValues, OutboundDeploymentBounds,
  OutboundProviderConfig, parseOutboundPolicyInput, loadOutboundConfig.

- [x] **Step 1: Write failing closed-contract tests**

Define expected public types:

~~~ts
export interface OutboundPolicyValues {
  readonly perContact15Minute: number;
  readonly perContact24Hour: number;
  readonly whatsappAccount1Minute: number;
  readonly messengerAccount1Minute: number;
  readonly global1Minute: number;
  readonly globalUtcDay: number;
  readonly workerBatchSize: number;
  readonly leaseMs: number;
  readonly providerTimeoutMs: number;
  readonly maximumDefiniteRetries: number;
  readonly retryBaseMs: number;
  readonly retryMaximumMs: number;
}

export type OutboundProviderResult =
  | { readonly status: 'accepted'; readonly providerMessageId: string }
  | {
      readonly status: 'definitely_rejected';
      readonly reasonCode: 'rate_limited' | 'provider_rejected';
      readonly retryAfter: Date | undefined;
    }
  | {
      readonly status: 'delivery_unknown';
      readonly reasonCode:
        | 'timeout'
        | 'network_failure'
        | 'invalid_response'
        | 'oversized_response'
        | 'redirect';
    }
  | { readonly status: 'aborted_before_dispatch' };
~~~

Test every enum, unknown key, non-integer, unsafe range, retry maximum below
base, lease not longer than timeout plus safety margin, and two-source bound
intersection.

- [x] **Step 2: Write failing configuration tests**

Require exact META_GRAPH_API_VERSION=v25.0 and explicit values for every
deployment ceiling/floor. Require HTTPS graph.facebook.com for production
configuration and allow only a loopback HTTP fake when
OUTBOUND_ALLOW_LOOPBACK_FAKE=true. Reject userinfo, path prefixes, query,
fragment, redirects, missing account credential references, and all defaults.

Test that returned credential wrappers cannot stringify or serialize their
secret and that safe snapshots contain booleans/counts only.

- [x] **Step 3: Run tests and confirm module-not-found failures**

Run:

~~~powershell
npm test -- --run tests/outbound-policy-input.test.ts tests/outbound-config.test.ts
~~~

- [x] **Step 4: Implement types, parsers, and configuration**

Use strict Zod objects. Keep the version as a literal:

~~~ts
export const META_GRAPH_API_VERSION = 'v25.0' as const;

export function resolveOutboundBounds(
  policy: OutboundPolicyValues,
  deployment: OutboundDeploymentBounds,
): OutboundPolicyValues;
~~~

Counts, batch size, attempts, lease, and timeout take the smaller allowed
value. Retry base/maximum take the longer required value while preserving
base <= maximum. Add blank keys only to .env.example; never add values.

- [x] **Step 5: Run focused and complete local checks**

Run:

~~~powershell
npm test -- --run tests/outbound-policy-input.test.ts tests/outbound-config.test.ts
npm run check
~~~

- [x] **Step 6: Commit and push**

~~~powershell
git add .env.example src/outbound/outbound-types.ts src/outbound/outbound-policy-input.ts src/outbound/outbound-config.ts tests/outbound-policy-input.test.ts tests/outbound-config.test.ts
git commit -m "feat: define outbound policy contracts"
git push origin main
~~~

## Task 3: Implement reviewed outbound policy and template repositories

**Files:**

- Create: src/outbound/outbound-template-input.ts
- Create: src/persistence/postgres-outbound-policy.ts
- Create: src/persistence/postgres-outbound-template.ts
- Create: tests/outbound-template-input.test.ts
- Create: tests/integration/postgres-outbound-policy.test.ts
- Create: tests/integration/postgres-outbound-template.test.ts

**Interfaces:**

- Consumes: ReviewerPrincipal, OutboundPolicyValues, fixed template commands.
- Produces: create/submit/approve/activate/retire/resolve policy methods and
  create/submit/approve/activate/retire/resolve fixed-template methods.

- [x] **Step 1: Write failing input tests**

The template command is strict and zero-variable:

~~~ts
export interface FixedTemplateVersionInput {
  readonly templateRef: string;
  readonly channel: 'whatsapp';
  readonly channelAccountId: string;
  readonly providerTemplateId: string;
  readonly templateName: string;
  readonly locale: 'bn_BD' | 'en_US';
  readonly category:
    | 'customer_support'
    | 'marketing_education'
    | 'marketing_events'
    | 'marketing_news'
    | 'marketing_offers';
  readonly contentSha256: string;
  readonly requestKey: string;
  readonly createdAt: Date;
}
~~~

Reject component/parameter/body fields, invalid references/digests, Messenger
templates, and unknown categories/locales.

- [x] **Step 2: Write failing guarded repository tests**

Cover immutable versions, separate submit/approve/activate, reviewer roles,
event-time activation, retirement, exact/conflicting replay, two-active
corruption failure, cross-account lookup denial, concurrent activation, and
transaction rollback.

- [x] **Step 3: Run focused tests and confirm failure**

~~~powershell
npm test -- --run tests/outbound-template-input.test.ts
npm run test:integration -- tests/integration/postgres-outbound-policy.test.ts tests/integration/postgres-outbound-template.test.ts
~~~

- [x] **Step 4: Implement repositories**

Expose exact methods:

~~~ts
class PostgresOutboundPolicy {
  createVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  submitVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  approveVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  activateVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  retireVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  resolveEffectivePolicy(
    evaluatedAt: Date,
    deployment: OutboundDeploymentBounds,
  ): Promise<EffectiveOutboundPolicy>;
}

class PostgresOutboundTemplate {
  createVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  submitVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  approveVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  activateVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  retireVersion(input: unknown, actor: ReviewerPrincipal): Promise<MutationResult>;
  resolveEffectiveTemplate(input: unknown): Promise<EffectiveFixedTemplate>;
}
~~~

All review evidence is append-only, request-key idempotent, and content-safe.

- [x] **Step 5: Run focused suites and checkpoint**

Run the commands from Step 3, then npm run check.

Commit and push:

~~~powershell
git add src/outbound/outbound-template-input.ts src/persistence/postgres-outbound-policy.ts src/persistence/postgres-outbound-template.ts tests/outbound-template-input.test.ts tests/integration/postgres-outbound-policy.test.ts tests/integration/postgres-outbound-template.test.ts
git commit -m "feat: add reviewed outbound policy and templates"
git push origin main
~~~

## Task 4: Create intents with enqueue-time eligibility

**Files:**

- Create: src/outbound/outbound-eligibility.ts
- Create: src/persistence/postgres-outbound-intent-store.ts
- Create: tests/outbound-eligibility.test.ts
- Create: tests/integration/postgres-outbound-intent-store.test.ts

**Interfaces:**

- Consumes: ready support draft or effective fixed template, current Phase 3
  authority, effective outbound policy.
- Produces: createSupportIntent, createFixedTemplateIntent and closed
  created/duplicate/denied outcomes.

- [x] **Step 1: Write failing pure eligibility tests**

Define:

~~~ts
export type OutboundEligibilityReason =
  | 'allowed'
  | 'policy_unavailable'
  | 'source_not_ready'
  | 'content_erased'
  | 'retention_expired'
  | 'active_review_overdue'
  | 'pause_active'
  | 'echo_correlation_hold'
  | 'privacy_hold'
  | 'identity_deleted'
  | 'suppressed'
  | 'consent_missing'
  | 'window_closed'
  | 'template_required'
  | 'template_invalid';

export const META_RESPONSE_WINDOW_MS = 86_400_000;
~~~

Test the exact open boundary at customer event + 24 hours, no later automated
event extension, Messenger and WhatsApp behavior, marketing exact-category
consent, legacy/global and scoped suppression precedence, fixed-template
category/locale/account scope, and active-client review deadline.

- [x] **Step 2: Write failing PostgreSQL intent tests**

Seed only synthetic applied events/drafts. Prove one intent under exact replay
and concurrent workers; conflicting request keys throw; no draft text or
external contact is copied; all guard denials create no intent; a source is
rechecked under lock; outside-window support cannot silently become a template.

- [x] **Step 3: Run focused tests and confirm failure**

~~~powershell
npm test -- --run tests/outbound-eligibility.test.ts
npm run test:integration -- tests/integration/postgres-outbound-intent-store.test.ts
~~~

- [x] **Step 4: Implement the transactional store**

Expose:

~~~ts
class PostgresOutboundIntentStore {
  createSupportIntent(input: {
    readonly draftRef: string;
    readonly evaluatedAt: Date;
    readonly requestKey: string;
  }): Promise<OutboundIntentResult>;

  createFixedTemplateIntent(input: {
    readonly conversationId: string;
    readonly templateRef: string;
    readonly purpose: OutboundPurpose;
    readonly evaluatedAt: Date;
    readonly requestKey: string;
  }): Promise<OutboundIntentResult>;
}
~~~

Lock source, conversation, identity, privacy/suppression/consent projections,
retention, active policy, and last qualifying customer event in deterministic
order. Derive all IDs/scopes server-side. Insert one content-free escalation
for terminal enqueue denial where the spec requires human follow-up.

- [x] **Step 5: Run tests, check, commit, and push**

~~~powershell
npm test -- --run tests/outbound-eligibility.test.ts
npm run test:integration -- tests/integration/postgres-outbound-intent-store.test.ts
npm run check
git add src/outbound/outbound-eligibility.ts src/persistence/postgres-outbound-intent-store.ts tests/outbound-eligibility.test.ts tests/integration/postgres-outbound-intent-store.test.ts
git commit -m "feat: add policy gated outbound intents"
git push origin main
~~~

## Task 5: Implement leases, rate reservations, retry, and expiry

**Files:**

- Create: src/persistence/postgres-outbound-work-store.ts
- Create: tests/integration/postgres-outbound-work-store.test.ts

**Interfaces:**

- Consumes: pending intents and EffectiveOutboundPolicy.
- Produces: claimBatch, authorizeAttempt, markDispatchStarted,
  recordProviderResult, expireLeases.

- [x] **Step 1: Write failing worker-state tests**

Use these signatures:

~~~ts
class PostgresOutboundWorkStore {
  claimBatch(input: {
    readonly claimedAt: Date;
    readonly workerRef: string;
  }): Promise<readonly ClaimedOutboundIntent[]>;

  authorizeAttempt(input: {
    readonly intentRef: string;
    readonly leaseRef: string;
    readonly evaluatedAt: Date;
  }): Promise<AuthorizeAttemptResult>;

  markDispatchStarted(input: {
    readonly attemptRef: string;
    readonly leaseRef: string;
    readonly startedAt: Date;
  }): Promise<DispatchStartResult>;

  recordProviderResult(input: {
    readonly attemptRef: string;
    readonly leaseRef: string;
    readonly completedAt: Date;
    readonly result: OutboundProviderResult;
  }): Promise<RecordProviderResultResult>;

  expireLeases(input: {
    readonly expiredAt: Date;
    readonly limit: number;
  }): Promise<ExpireOutboundResult>;
}
~~~

Cover duplicate claims, SKIP LOCKED, batch limit, lease ownership, expiry before
dispatch returning to pending, expiry after dispatch becoming unknown, exact
result replay, invalid transitions, crash points, definite retry scheduling,
maximum retry terminal failure, and one escalation.

- [x] **Step 2: Write failing rate-limit tests**

Prove serialized per-contact 15-minute/24-hour, channel-account minute,
global-minute, global-UTC-day limits; exact boundary expiry; WhatsApp/Messenger
separation; no attempt on denial; and customized stricter deployment values.
Hold advisory locks to prove bounded rollback and clean retry.

- [x] **Step 3: Run focused test and confirm failure**

~~~powershell
npm run test:integration -- tests/integration/postgres-outbound-work-store.test.ts
~~~

- [x] **Step 4: Implement transactional work state**

Use SKIP LOCKED only for claim. Use one fixed advisory-lock namespace and
deterministic scope ordering for authorization. Re-run every eligibility query
from Task 4 inside authorizeAttempt. A rate reservation and authorized attempt
commit together.

recordProviderResult must:

- accepted: require one provider ID, mark attempt/intention provider_accepted;
- definitely_rejected below maximum: schedule exponential bounded retry;
- definitely_rejected at maximum: terminal_failed plus one escalation;
- delivery_unknown: delivery_unknown plus one escalation and no retry;
- aborted_before_dispatch: return safely to pending without incrementing a
  provider retry.

- [x] **Step 5: Run tests and checkpoint**

~~~powershell
npm run test:integration -- tests/integration/postgres-outbound-work-store.test.ts
npm run check
git add src/persistence/postgres-outbound-work-store.ts tests/integration/postgres-outbound-work-store.test.ts
git commit -m "feat: add bounded outbound leases and retries"
git push origin main
~~~

## Task 6: Build process-issued channel requests

**Files:**

- Create: src/outbound/outbound-request.ts
- Create: tests/outbound-request.test.ts

**Interfaces:**

- Consumes: locked dispatch material from PostgresOutboundWorkStore.
- Produces: PreparedOutboundRequest objects recognized by adapter provenance.

- [x] **Step 1: Write failing request-builder tests**

Expected builders:

~~~ts
export function buildWhatsAppTextRequest(input: unknown): PreparedOutboundRequest;
export function buildWhatsAppFixedTemplateRequest(
  input: unknown,
): PreparedOutboundRequest;
export function buildMessengerTextRequest(input: unknown): PreparedOutboundRequest;
export function readPreparedOutboundRequest(
  value: unknown,
): PreparedOutboundRequestContext | undefined;
~~~

Assert exact v25.0 endpoint, POST, closed JSON body, preview_url false,
messaging_type RESPONSE, fixed template with name/locale and no components,
bounded text, no arbitrary URL, no unknown fields, no secret in object
inspection/JSON, and WeakMap/WeakSet process provenance.

- [x] **Step 2: Run test and confirm failure**

~~~powershell
npm test -- --run tests/outbound-request.test.ts
~~~

- [x] **Step 3: Implement strict builders**

WhatsApp text body:

~~~ts
{
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: recipient,
  type: 'text',
  text: { body: text, preview_url: false },
}
~~~

Messenger text body:

~~~ts
{
  recipient: { id: recipient },
  messaging_type: 'RESPONSE',
  message: { text },
}
~~~

Fixed WhatsApp template body contains messaging_product, to, type template,
name, and language.code only. Freeze all returned structures.

- [x] **Step 4: Run tests, check, commit, and push**

~~~powershell
npm test -- --run tests/outbound-request.test.ts
npm run check
git add src/outbound/outbound-request.ts tests/outbound-request.test.ts
git commit -m "feat: build closed meta outbound requests"
git push origin main
~~~

## Task 7: Implement fail-closed Meta HTTP adapters

**Files:**

- Create: src/outbound/meta-outbound-client.ts
- Create: tests/helpers/fake-meta-server.ts
- Create: tests/meta-outbound-client.test.ts

**Interfaces:**

- Consumes: builder-issued PreparedOutboundRequest and protected credential.
- Produces: Promise<OutboundProviderResult>.

- [x] **Step 1: Write failing adapter contract tests**

Test one POST, exact host/path/version, authorization presence without value
capture, timeout, caller abort, connect failure, redirect rejection, maximum
success bytes, malformed JSON, missing/duplicate/invalid provider ID, 400
definite rejection, approved 429 definite retry, 500/timeout/transport
delivery_unknown, and closed logging.

The fake must reject any non-loopback bind and any credential not matching an
obvious synthetic sentinel. It records only method, path, body shape booleans,
call count, abort count, and closed outcome.

- [x] **Step 2: Run test and confirm failure**

~~~powershell
npm test -- --run tests/meta-outbound-client.test.ts
~~~

- [x] **Step 3: Implement one-attempt client**

Expose:

~~~ts
export class MetaOutboundClient {
  public constructor(options: MetaOutboundClientOptions);
  public send(input: {
    readonly request: PreparedOutboundRequest;
    readonly signal?: AbortSignal;
  }): Promise<OutboundProviderResult>;
}
~~~

Use redirect error, total AbortController timeout, bounded streaming reads, and
strict per-channel success schemas. Never read non-2xx bodies. Treat only the
reviewed response-code allowlist as definitely rejected; classify every
uncertain result as delivery_unknown.

- [x] **Step 4: Run tests and checkpoint**

~~~powershell
npm test -- --run tests/meta-outbound-client.test.ts
npm run check
git add src/outbound/meta-outbound-client.ts tests/helpers/fake-meta-server.ts tests/meta-outbound-client.test.ts
git commit -m "feat: add fail closed meta outbound client"
git push origin main
~~~

## Task 8: Compose the outbound worker

**Files:**

- Modify: src/persistence/postgres-outbound-work-store.ts
- Create: src/outbound/outbound-worker.ts
- Create: tests/outbound-worker.test.ts
- Create: tests/integration/postgres-outbound-flow.test.ts

**Interfaces:**

- Consumes: PostgresOutboundWorkStore, builders, MetaOutboundClient.
- Produces: runBatch with aggregate, content-free outcomes.

- [x] **Step 1: Write failing unit composition tests**

Define:

~~~ts
export interface OutboundBatchResult {
  readonly claimed: number;
  readonly accepted: number;
  readonly deferred: number;
  readonly canceled: number;
  readonly unknown: number;
  readonly failed: number;
}

export class OutboundWorker {
  public runBatch(input: {
    readonly evaluatedAt: Date;
    readonly workerRef: string;
    readonly signal?: AbortSignal;
  }): Promise<OutboundBatchResult>;
}
~~~

Prove claim then authorize then dispatch-start then exactly one adapter call
then result persistence. FAQ/model origin must not alter provider behavior.
Denied authorization never builds/calls. Active duplicate/replay does not call.

- [x] **Step 2: Write failing end-to-end PostgreSQL flow tests**

Cover one ready draft to one accepted intent/attempt, concurrent workers, crash
before/after dispatch start, timeout unknown, definite retry/exhaustion,
customized limits, late pause/privacy/deletion/suppression/window/retention
races, erased draft, and zero duplicate calls.

- [x] **Step 3: Run tests and confirm failure**

~~~powershell
npm test -- --run tests/outbound-worker.test.ts
npm run test:integration -- tests/integration/postgres-outbound-flow.test.ts
~~~

- [x] **Step 4: Implement minimal worker composition**

The worker catches only expected closed provider outcomes. Database exceptions
before dispatch cause no provider call. Database failure after dispatch start
is allowed to leave the lease for expiry-to-unknown; never issue a compensating
send.

- [x] **Step 5: Run suites and checkpoint**

~~~powershell
npm test -- --run tests/outbound-worker.test.ts
npm run test:integration -- tests/integration/postgres-outbound-flow.test.ts
npm run check
git add src/outbound/outbound-worker.ts tests/outbound-worker.test.ts tests/integration/postgres-outbound-flow.test.ts
git commit -m "feat: compose policy safe outbound worker"
git push origin main
~~~

## Task 9: Correlate WhatsApp and stable-ID Messenger statuses

**Files:**

- Modify: src/meta/normalized-event.ts
- Modify: src/meta/normalize-messenger.ts
- Create: src/persistence/postgres-outbound-status.ts
- Modify: src/persistence/postgres-conversation-event-processor.ts
- Modify: tests/meta/normalize-messenger.test.ts
- Create: tests/integration/postgres-outbound-status.test.ts

**Interfaces:**

- Consumes: admitted normalized message_status events and accepted attempts.
- Produces: append-only status evidence and monotonic intent delivery state.

- [x] **Step 1: Write failing Messenger normalization tests**

Add Messenger delivery items with stable mids and split each mid into a
message_status event. Use the canonical fallback idempotency key from
docs/architecture/webhook-admission.md. Keep read-watermark-only, malformed,
missing-mid, reaction, and unknown events unsupported with no status effect.

- [x] **Step 2: Write failing PostgreSQL status tests**

Expected method:

~~~ts
class PostgresOutboundStatus {
  applyEvent(webhookEventId: string): Promise<
    | { readonly status: 'applied'; readonly deliveryState: DeliveryState }
    | { readonly status: 'duplicate' | 'uncorrelated' | 'not_processable' }
  >;
}
~~~

Cover WhatsApp sent/delivered/read/failed in every order, exact/logical replay,
unknown provider ID, cross-account/cross-channel collision, lower-rank no
downgrade, failed then later delivered/read correction, and no retention anchor
movement.

- [x] **Step 3: Run tests and confirm failure**

~~~powershell
npm test -- --run tests/meta/normalize-messenger.test.ts
npm run test:integration -- tests/integration/postgres-outbound-status.test.ts
~~~

- [x] **Step 4: Implement normalization and status repository**

Lock webhook event and correlated intent. Insert one status row per authoritative
event. Use success rank provider_accepted < sent < delivered < read. Failed is
terminal only without delivered/read evidence; later delivered/read may correct
it. Extend event application outcomes with message_status_applied and
message_status_uncorrelated without treating either as conversation activity.

- [x] **Step 5: Run tests and checkpoint**

~~~powershell
npm test -- --run tests/meta/normalize-messenger.test.ts
npm run test:integration -- tests/integration/postgres-outbound-status.test.ts
npm run check
git add src/meta/normalized-event.ts src/meta/normalize-messenger.ts src/persistence/postgres-outbound-status.ts src/persistence/postgres-conversation-event-processor.ts tests/meta/normalize-messenger.test.ts tests/integration/postgres-outbound-status.test.ts
git commit -m "feat: correlate outbound delivery statuses"
git push origin main
~~~

## Task 10: Prevent Messenger self-echo takeover races

**Files:**

- Create: src/persistence/postgres-outbound-echo-correlation.ts
- Modify: src/persistence/postgres-conversation-event-processor.ts
- Modify: src/persistence/postgres-outbound-intent-store.ts
- Modify: src/persistence/postgres-outbound-work-store.ts
- Modify: tests/integration/postgres-conversation-event-processor.test.ts
- Create: tests/integration/postgres-outbound-echo-correlation.test.ts

**Interfaces:**

- Consumes: Messenger business echoes, accepted or dispatch-started attempts.
- Produces: correlated self-echo, bounded hold, or existing authoritative pause.

- [ ] **Step 1: Write failing correlation race tests**

Cover echo after stored provider ID, echo before response, exact echo replay,
provider ID mismatch, two concurrent in-flight attempts, attempt unknown,
attempt expiry, hold expiry, actual staff echo during dispatch, no text-based
matching, and no further enqueue/send while a hold is open.

- [ ] **Step 2: Run focused tests and confirm failure**

~~~powershell
npm run test:integration -- tests/integration/postgres-conversation-event-processor.test.ts tests/integration/postgres-outbound-echo-correlation.test.ts
~~~

- [ ] **Step 3: Implement correlation**

Expose:

~~~ts
class PostgresOutboundEchoCorrelation {
  processBusinessEcho(webhookEventId: string): Promise<
    | { readonly status: 'self_echo' }
    | { readonly status: 'correlation_pending' }
    | { readonly status: 'human_pause_applied' }
    | { readonly status: 'duplicate' | 'not_processable' }
  >;

  resolveExpiredHolds(input: {
    readonly evaluatedAt: Date;
    readonly limit: number;
  }): Promise<{ readonly paused: number; readonly selfEchoes: number }>;
}
~~~

Create a hold only from a locked dispatch_started attempt for the same
conversation. Hold presence is a send-time guard. Exact provider-ID match
records service_echo_correlated. Unknown/expired/no-match applies the existing
pause from the echo provider timestamp.

- [ ] **Step 4: Run tests and checkpoint**

~~~powershell
npm run test:integration -- tests/integration/postgres-conversation-event-processor.test.ts tests/integration/postgres-outbound-echo-correlation.test.ts
npm run check
git add src/persistence/postgres-outbound-echo-correlation.ts src/persistence/postgres-conversation-event-processor.ts src/persistence/postgres-outbound-intent-store.ts src/persistence/postgres-outbound-work-store.ts tests/integration/postgres-conversation-event-processor.test.ts tests/integration/postgres-outbound-echo-correlation.test.ts
git commit -m "feat: guard messenger outbound echo races"
git push origin main
~~~

## Task 11: Integrate deletion, opt-out, retention, and access boundaries

**Files:**

- Modify: src/persistence/postgres-deletion-policy.ts
- Modify: src/persistence/postgres-deletion-erasure.ts
- Modify: src/persistence/postgres-marketing-opt-out-policy.ts
- Modify: src/persistence/postgres-retention-job.ts
- Modify: src/persistence/postgres-access-export.ts
- Modify: tests/integration/postgres-deletion-policy.test.ts
- Modify: tests/integration/postgres-marketing-opt-out-policy.test.ts
- Modify: tests/integration/postgres-retention-job.test.ts
- Modify: tests/integration/postgres-access-export.test.ts
- Create: tests/integration/postgres-outbound-privacy-interactions.test.ts

**Interfaces:**

- Consumes: existing authoritative privacy/lifecycle commands.
- Produces: atomic cancellation/erasure of eligible outbound work and
  allowlisted access behavior.

- [ ] **Step 1: Write failing cross-feature tests**

Prove deletion cancels pending/leased/authorized-before-dispatch intents,
erases dependent draft content, leaves content-free attempt/status evidence,
never requeues dispatch_started, and completes pending_outbound location only
after reconciliation.

Prove global/scoped marketing opt-out cancels matching pending template intents
atomically; re-opt-in does not resurrect canceled work. Prove retention expiry
cancels/erases without moving anchors. Prove access output contains only the
already approved allowlisted categories and no provider message ID, lease,
recipient, token, request, response, or error detail.

- [ ] **Step 2: Run focused tests and confirm failure**

~~~powershell
npm run test:integration -- tests/integration/postgres-deletion-policy.test.ts tests/integration/postgres-marketing-opt-out-policy.test.ts tests/integration/postgres-retention-job.test.ts tests/integration/postgres-access-export.test.ts tests/integration/postgres-outbound-privacy-interactions.test.ts
~~~

- [ ] **Step 3: Implement transactional integration**

Use table existence guards only where older isolated restore schemas require
them. Lock identities/intents in ascending internal ID order. Cancellation
updates use closed reasons and cannot mutate append-only attempt/status
evidence. Never select content or external identity into evidence queries.

- [ ] **Step 4: Run tests and checkpoint**

Run the command from Step 2, then npm run check.

Commit and push:

~~~powershell
git add src/persistence/postgres-deletion-policy.ts src/persistence/postgres-deletion-erasure.ts src/persistence/postgres-marketing-opt-out-policy.ts src/persistence/postgres-retention-job.ts src/persistence/postgres-access-export.ts tests/integration/postgres-deletion-policy.test.ts tests/integration/postgres-marketing-opt-out-policy.test.ts tests/integration/postgres-retention-job.test.ts tests/integration/postgres-access-export.test.ts tests/integration/postgres-outbound-privacy-interactions.test.ts
git commit -m "feat: enforce outbound privacy lifecycle"
git push origin main
~~~

## Task 12: Complete Phase 5 evidence and gate review

**Files:**

- Create: docs/architecture/outbound-messaging.md
- Create: docs/testing/phase-5-outbound-evidence.md
- Create: docs/operations/outbound-worker.md
- Create: docs/reviews/phase-5-gate.md
- Modify: docs/architecture/channel-behavior.md
- Modify: docs/architecture/webhook-admission.md
- Modify: docs/security/threat-model.md
- Modify: docs/testing/acceptance-matrix.md
- Modify: docs/TODO.md
- Modify: docs/PROJECT_CONTEXT.md
- Modify: docs/superpowers/plans/2026-09-15-phase-5-outbound-messaging.md

**Interfaces:**

- Consumes: exact evidence from Tasks 1 through 11.
- Produces: P5-002 through P5-005 completion evidence and P5-GATE decision.

- [ ] **Step 1: Run all focused Phase 5 tests**

Run:

~~~powershell
npm test -- --run tests/outbound-policy-input.test.ts tests/outbound-config.test.ts tests/outbound-template-input.test.ts tests/outbound-eligibility.test.ts tests/outbound-request.test.ts tests/meta-outbound-client.test.ts tests/outbound-worker.test.ts tests/meta/normalize-messenger.test.ts
npm run test:integration -- tests/integration/postgres-outbound-policy.test.ts tests/integration/postgres-outbound-template.test.ts tests/integration/postgres-outbound-intent-store.test.ts tests/integration/postgres-outbound-work-store.test.ts tests/integration/postgres-outbound-flow.test.ts tests/integration/postgres-outbound-status.test.ts tests/integration/postgres-outbound-echo-correlation.test.ts tests/integration/postgres-outbound-privacy-interactions.test.ts
~~~

Record exact counts from output only.

- [ ] **Step 2: Run complete gates**

~~~powershell
npm run check
docker compose -f infra/compose.test.yml run --rm runner
~~~

Record exact file/test counts. Query aggregates only to confirm zero leftover
test schemas and zero advisory locks.

- [ ] **Step 3: Run repository safety review**

Run git diff --check, formatting, changed/staged file review, targeted
credential patterns, and synthetic fixture scan. Confirm no environment file,
dump, export, recording, screenshot, raw provider body, external identity, or
credential was added.

- [ ] **Step 4: Write evidence and operations documents**

Document:

- exact PostgreSQL state machine and at-most-once ambiguity rule;
- required v25.0 support-window recheck;
- customizable policy and deployment intersection;
- start/stop, lease recovery, unknown-delivery review, and aggregate metrics;
- no live provider/test-asset/deployment claim;
- AC-06/07/23/24/25 outcomes and remaining P6/P7/P8 gates.

- [ ] **Step 5: Update tracker and gate**

Mark P5-002 through P5-005 complete only if their evidence passes. Record
P5-GATE local pass under delegated approval only if every Phase 5 exit
condition passes. Unblock P6-001 planning only; do not authorize deployment,
Meta sends, credentials, test assets, or production.

- [ ] **Step 6: Re-run validation after documentation formatting**

Run npm run check and the complete guarded PostgreSQL suite again. Re-run
git diff --check and safety scans.

- [ ] **Step 7: Commit and push**

~~~powershell
git add docs src tests migrations .env.example
git commit -m "feat: complete phase 5 outbound messaging"
git push origin main
~~~

Verify HEAD equals origin/main and the working tree is clean.

## Final Completion Conditions

Phase 5 is locally complete only when:

- one durable intent exists per logical source under concurrency/replay;
- enqueue and dispatch independently enforce every specified guard;
- all limits/timing are explicit, reviewed, and customizable;
- no post-dispatch ambiguous path can automatically resend;
- WhatsApp statuses advance monotonically and Messenger stable-ID events do not
  guess correlation;
- Messenger self-echo races cannot create a false service echo or bypass a
  human pause;
- deletion/opt-out/retention cancel eligible work transactionally;
- adapters pass only against loopback fakes with synthetic credentials;
- complete local and guarded PostgreSQL gates pass;
- the gate distinguishes local fake evidence from later live Meta evidence; and
- every checkpoint is pushed with clean main equal to origin/main.

Phase 5 completion does not authorize a live Meta call, provider token use,
test-number/Page send, deployment, public route change, customer data, or
production action.
