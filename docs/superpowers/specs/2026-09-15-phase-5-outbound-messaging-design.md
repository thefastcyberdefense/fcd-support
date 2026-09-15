# Phase 5 Outbound Messaging Design

Status: approved for local implementation under the project owner's recorded
delegation. External Meta calls, test-asset sends, deployment, and production
actions remain separately gated.

Date: 2026-09-15

## Purpose

Phase 5 turns a ready Phase 4 reply draft into a policy-eligible outbound
message without making process memory, a worker, Meta, or n8n authoritative.
It provides a PostgreSQL outbox, separate WhatsApp and Messenger adapters,
last-moment eligibility checks, configurable rate controls, bounded recovery,
and idempotent delivery-status correlation.

The primary safety goal is not to claim impossible end-to-end exactly-once
delivery. The system guarantees one durable intent per logical source and never
blindly repeats a dispatch whose provider outcome may be ambiguous.

## Scope

Phase 5 implements:

- one PostgreSQL-authoritative outbound intent per reply draft or explicitly
  reviewed fixed template request;
- explicit intent, lease, attempt, delivery, cancellation, unknown, and
  terminal-failure states;
- worker claim, authorization, dispatch-start, result, lease-expiry, and
  reconciliation transactions;
- WhatsApp text/fixed-template and Messenger text adapters behind one closed
  provider interface;
- a required, exact Graph API v25.0 configuration;
- customer-service-window, template, pause, privacy, deletion, suppression,
  consent, retention, and content-erasure checks before enqueue and dispatch;
- configurable per-contact, per-channel-account, and global limits;
- WhatsApp sent, delivered, read, and failed status correlation;
- Messenger delivery correlation when a stable provider message ID exists;
- Messenger self-echo correlation holds around in-flight service sends; and
- deterministic, content-free outbound escalation evidence.

## Non-goals

Phase 5 does not:

- call Meta with a live token or send a real message during implementation;
- deploy a worker, alter the Cloudflare Tunnel, or change any Meta asset;
- link, unlink, migrate, register, or subscribe the production WhatsApp number;
- treat Meta acceptance as delivery;
- automatically resend an ambiguous dispatch;
- enable unrestricted bulk marketing, variable templates, media, reactions,
  sender actions, message tags, or Messenger read-watermark inference;
- let n8n enqueue, send, retry, correlate, cancel, or own outbound state;
- add a public outbound or admin route; or
- replace later P6 operational hardening and P7 test-asset evidence.

## Selected Architecture

The selected design is a safety-first transactional outbox.

1. A domain service locks a ready reply draft or reviewed fixed template,
   rechecks eligibility, and creates one immutable logical intent.
2. A worker claims eligible pending intents with SKIP LOCKED and a bounded
   lease.
3. A separate authorization transaction locks the intent and all relevant
   policy state, rechecks eligibility, reserves rate capacity, and creates an
   authorized attempt.
4. The worker records dispatch_started before making the HTTP request.
5. The channel adapter makes one bounded request to the exact pinned endpoint.
6. A valid success stores the provider message ID and provider acceptance.
7. A documented definite rejection may become a bounded retry or terminal
   failure. Timeout, connection loss after dispatch start, malformed success,
   process crash, or any uncertain outcome becomes delivery_unknown and is not
   automatically resent.
8. Signed webhook events append status/correlation evidence and advance the
   projection without allowing older events to downgrade it.

Rejected alternatives:

- At-least-once automatic resend improves apparent availability but can send
  duplicate customer messages after a response or process crash.
- An n8n-owned queue fragments authority and can diverge from PostgreSQL
  consent, deletion, and takeover state.
- Calling Meta inside a database transaction holds locks across an external
  boundary without making the external side effect atomic.

## Authority And Trust Boundaries

PostgreSQL is authoritative for:

- the logical outbound intent and its source;
- current intent state and lease ownership;
- dispatch attempts and whether dispatch began;
- the exact policy version and rate reservation used;
- provider-message correlation;
- signed provider status evidence;
- cancellation, unknown, failure, and escalation outcomes; and
- reviewed template and policy history.

Meta is authoritative only for its returned provider message ID and signed
delivery-status events. A success response means accepted by Meta, not
delivered to the customer.

n8n may later receive sanitized notifications. It cannot mutate outbound
authority. OpenClaw, Hermes, Manifest, and model output never enter the provider
path as credentials, routers, tools, or state authorities.

## Graph API Version And Endpoints

Graph API v25.0 is the only accepted runtime value for this phase. Meta's
version schedule records v25.0 as introduced on 2026-02-18 and available
through 2028-07-29. The repository inventory already found v25.0 in runtime
configuration, while v26.0 appeared only in webhook-tester samples.

Before any live P7 send, the operator must recheck the official changelog,
permissions, request shapes, and end-of-support date. A changed, missing,
unversioned, older, or newer configured value fails startup; upgrades require a
reviewed code/spec change and adapter contract rerun.

The adapters build URLs internally:

- WhatsApp: https://graph.facebook.com/v25.0/{phone-number-id}/messages
- Messenger: https://graph.facebook.com/v25.0/{page-id}/messages

Callers cannot supply a host, path, query string, redirect policy, or arbitrary
URL. Redirects are rejected. Credentials are runtime-injected per channel
account, never returned from configuration, persisted, or logged.

Primary references:

- https://developers.facebook.com/docs/graph-api/changelog/
- https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
- https://developers.facebook.com/docs/messenger-platform/send-messages
- https://www.postman.com/meta/whatsapp-business-platform/overview
- https://www.postman.com/meta/messenger-platform-api/overview

## PostgreSQL Model

Migration 000012 introduces closed tables and constraints.

### outbound_policy_versions

Immutable reviewed values have no database defaults:

- policy_ref and version_number;
- per_contact_15_minute;
- per_contact_24_hour;
- whatsapp_account_1_minute;
- messenger_account_1_minute;
- global_1_minute;
- global_utc_day;
- worker_batch_size;
- lease_ms;
- provider_timeout_ms;
- maximum_definite_retries;
- retry_base_ms;
- retry_maximum_ms;
- state, created_at, decided_at, and retired_at.

Append-only outbound_policy_review_events separately submit, approve, activate,
and retire a version. Exactly one version may be active at an event time.
Protected deployment settings supply independent ceilings for counts, batch,
lease, timeout, and retries plus floors for retry delays. Effective counts and
durations take the stricter value. Configuration has no enabling defaults.

The Meta-defined 24-hour response window is a platform rule, not a tunable
business limit.

### outbound_template_versions

The first implementation supports fixed, zero-variable Meta templates only.
Each immutable version stores an internal reference, channel/account scope,
provider template identifier, template name, locale, category, content digest,
review state, decision time, and retirement time. It stores no customer values
or token.

Review and activation are separate append-only events. A template send must
reference the exact effective approved version. Variable templates are rejected
until a separate design specifies value provenance, redaction, storage, and
review.

### outbound_intents

Each intent has:

- an opaque intent_ref and unique request_key;
- exactly one source: a ready support_reply_draft or an approved fixed
  template version;
- conversation_id and channel_identity_id;
- channel and channel-account scope derived from that identity;
- purpose: customer_support or one closed marketing category;
- message kind: support_text or fixed_template;
- state: pending, leased, provider_accepted, sent, delivered, read,
  delivery_unknown, terminal_failed, or canceled;
- next_attempt_at, lease fields, attempt_count, policy_version_id;
- retention_deadline and timestamps; and
- closed cancellation/failure reason codes.

One reply draft can create at most one intent. Intent rows do not duplicate
message text or an external contact identifier. The adapter loads the current
locked draft/template and channel identity only into caller memory immediately
before dispatch.

### outbound_attempts

One append-only row represents one authorized provider attempt:

- intent_id and monotonically increasing attempt_number;
- attempt_ref;
- state: authorized, dispatch_started, provider_accepted,
  definitely_rejected, delivery_unknown, or abandoned_before_dispatch;
- policy_version_id and rate-reservation references;
- provider_message_id only after a validated acceptance;
- closed outcome/reason code and timestamps.

No request body, response body, authorization header, token, customer content,
external identity, exception text, or provider error detail is stored.
Provider message IDs are unique within channel/account scope.

### outbound_status_events

Each signed, admitted message-status webhook can append at most one row linked
to its webhook event and correlated attempt. Stored fields are the internal
event/intent/attempt IDs, closed status, provider timestamp, and created time.
Raw payload and recipient values stay in their existing admission record and
are not copied.

### outbound_rate_windows and outbound_escalation_outcomes

Rate windows store policy version, closed scope kind, internal or HMAC-derived
scope, exact window bounds, count, and expiry. Advisory locks serialize all
affected scopes before a reservation.

Escalations store only internal references, a closed reason, state, and
timestamps. Reasons include policy_unavailable, limit_exhausted, pause_active,
privacy_hold, identity_deleted, suppressed, consent_missing, window_closed,
template_required, template_invalid, content_erased, retention_expired,
provider_rejected, delivery_unknown, and retry_exhausted.

## Enqueue Eligibility

Creating an intent is a bounded transaction that locks the draft/template,
conversation, channel identity, and current policy projection. It denies when:

- the source is missing, erased, expired, already linked, or not ready;
- the conversation is paused or has an unresolved echo-correlation hold;
- an access, correction, or deletion privacy hold is open;
- the identity is deleted or suppressed;
- retention has expired or an active-client review is overdue;
- no single reviewed outbound policy is active;
- customer_support lacks a customer-originated message inside the channel's
  24-hour response window;
- a template is missing, inactive, retired, cross-account, cross-channel, or
  outside its reviewed category/locale;
- a marketing purpose lacks the latest explicit grant for the exact identity,
  channel, and category; or
- a global or scoped opt-out applies.

The exact checks repeat immediately before dispatch. Earlier eligibility is
evidence, not authority for a later send.

Support reply drafts produce support_text intents only inside the response
window. The system never transforms a free-form draft into a template. Outside
the window it cancels safely with template_required and an escalation.

## Leasing, Dispatch, And Recovery

Claiming uses FOR UPDATE SKIP LOCKED ordered by next_attempt_at and ID, capped by
the effective worker batch size. A random process-issued lease reference and
expiry identify the worker.

Authorization rechecks the lease and every eligibility rule, reserves all rate
scopes atomically, and creates one authorized attempt. A crash before
dispatch_started allows the expired lease to return the intent to pending
without consuming a provider retry. A crash after dispatch_started changes the
attempt and intent to delivery_unknown.

The worker commits dispatch_started before I/O. This creates a deliberate
at-most-once bias: a crash in the small interval before bytes leave may require
manual review, but it cannot cause a blind duplicate.

Automatic retry is permitted only for a closed, reviewed adapter outcome that
proves Meta definitely rejected the request. The delay is exponential,
bounded by configured base/maximum values and any valid Retry-After value.
Unknown, malformed, timeout, redirect, body-limit, and transport outcomes are
never automatically retried.

When the maximum definite retries is exhausted, the intent becomes
terminal_failed and creates one escalation. Exact worker replay returns the
stored result without a second provider call.

## Provider Contracts

Both adapters accept only process-issued prepared requests. Common input:

- attempt_ref;
- channel/account and recipient values loaded from the authoritative identity;
- support text or an effective fixed-template descriptor;
- effective timeout and maximum response bytes; and
- an opaque intent reference where the official channel contract supports
  callback metadata.

Common output is closed:

- accepted with one validated provider message ID;
- definitely_rejected with a bounded reason and optional retry-after time;
- delivery_unknown with a bounded reason; or
- aborted before dispatch.

WhatsApp support text uses messaging_product whatsapp, recipient_type
individual, type text, and preview_url false. Fixed templates use only the
reviewed name and locale and contain no components in this phase.

Messenger support text uses messaging_type RESPONSE and a text message.
Fixed-template Messenger output is disabled until a separate reviewed template
shape is added. Extra fields, media, quick replies, tags, sender actions, and
caller-provided metadata are rejected.

Both adapters:

- make one POST with a hard timeout and caller abort;
- reject redirects;
- bound success bytes before JSON parsing;
- never read or log non-success bodies;
- validate a single provider message identifier;
- classify malformed success as delivery_unknown; and
- expose no provider token through errors or return values.

Local HTTP fakes accept obvious synthetic credentials only, inspect structure,
and retain only booleans, counts, and closed outcomes.

## Status Ordering And Correlation

WhatsApp sent, delivered, read, and failed statuses correlate by channel,
channel account, and provider message ID. Exact webhook replay is a no-op.

The success progression is provider_accepted to sent to delivered to read.
Older or lower-ranked success evidence cannot downgrade state. Failed is
terminal only when no delivered/read evidence exists. A later signed
delivered/read event may correct an earlier out-of-order failed projection;
the append-only history preserves both facts.

Messenger delivery events may update state only when they include a stable
message ID that matches a stored provider message ID. Read-watermark-only
events remain unsupported in this phase because inferring one intent would be
unsafe.

## Messenger Self-Echo Race

A Messenger business echo first attempts exact provider-message correlation.
When matched, it records service_echo_correlated and never pauses AI.

If no provider ID is stored but the conversation has a recent
dispatch_started attempt, the echo enters an outbound_echo_correlation_hold.
While the hold is open, reply enqueue and dispatch are denied.

- If the attempt later stores the matching provider ID, the echo becomes a
  correlated self-echo.
- If the attempt becomes delivery_unknown, the lease expires, or the bounded
  hold expires without a match, the existing business-echo application runs
  and pauses AI from the echo's provider timestamp.
- If no plausible in-flight service attempt exists, the existing fail-safe
  pause applies immediately.

Correlation never uses message text, display name, recipient direction alone,
or timing proximity. The candidate hold is created only from an authoritative
dispatch_started attempt for the same locked conversation.

## Privacy, Retention, And Erasure

Deletion, suppression, privacy holds, and retention jobs cancel every pending,
leased, or authorized-before-dispatch intent and erase/cancel referenced local
content according to existing policy. They cannot recall a provider-accepted
message.

An intent with dispatch_started may become delivery_unknown but is never
requeued by erasure. Attempts and status history retain only the approved
content-free evidence fields and expire with the narrowest applicable
retention deadline.

Provider error bodies, raw status payloads, customer text copies, and token
material never enter outbox evidence, logs, fixtures, or alerts.

## Observability

Allowlisted logs contain event name, channel enum, intent/attempt state, bounded
reason code, counts, duration, and internal request reference only. They exclude
message text, external identity, provider message ID, payload, URL parameters,
headers, tokens, SQL parameters, and exception detail.

Metrics are aggregate counts for queue depth, lease expiry, accepted,
delivery_unknown, terminal failure, cancellation reason, rate denial, and
status progression. P6 later owns sanitized alert delivery.

## Testing

All implementation is test-first with local fakes and isolated PostgreSQL.

Required migration tests:

- up/down/reapply and populated downgrade refusal;
- closed states/reasons and impossible-state constraints;
- one draft/intent, provider-ID uniqueness, append-only attempts/statuses;
- no raw body, token, external-recipient, or duplicated-message columns.

Required outbox tests:

- concurrent enqueue and worker claims;
- exact/conflicting replay;
- crash before/after dispatch_started;
- lease expiry and ownership conflicts;
- definite retry backoff/exhaustion;
- timeout/transport/malformed success to delivery_unknown;
- deletion, retention, pause, privacy, and suppression races.

Required policy tests:

- no active policy and two-active-policy failure;
- configurable limits and stricter deployment intersection;
- contact, WhatsApp-account, Messenger-account, minute/day/global windows;
- exact marketing consent and opt-out precedence;
- exact 24-hour boundaries and late customer-event ordering;
- fixed-template scope, state, locale, category, and retirement.

Required adapter tests:

- exact v25.0 URL/path and channel payload;
- no arbitrary URL, redirect, media, tool, or extra field;
- bounded timeout/body and caller abort;
- accepted, definite rejection, unknown, and secret-safe logging;
- no real network or credential.

Required correlation tests:

- WhatsApp exact/out-of-order/duplicate statuses;
- lower-ranked status cannot downgrade;
- later delivery/read can correct earlier failed projection;
- unknown provider ID is ignored safely;
- Messenger stable-ID delivery;
- echo before/after provider response, crash/expiry, false-match prevention,
  and correlation-hold send blocking.

## Implementation Order

1. Add migration 000012 and migration-cycle tests.
2. Add closed outbound types, policy/template inputs, and configuration.
3. Implement reviewed policy/template repositories.
4. Implement transactional enqueue and send-time eligibility.
5. Implement leases, attempts, rate reservations, expiry, and safe recovery.
6. Implement fail-closed channel request builders and HTTP adapters.
7. Implement the worker composition and deterministic retry/unknown outcomes.
8. Implement WhatsApp/Messenger status normalization and correlation.
9. Implement Messenger echo-correlation holds and takeover integration.
10. Extend deletion, opt-out, retention, access, threat, acceptance, operations,
    and gate evidence.

## Completion And Approval Boundary

P5-002 through P5-005 are locally complete only when the complete local and
guarded PostgreSQL suites pass, adapter tests use loopback fakes only, fixture
and secret scans pass, and P5-GATE records exact evidence.

Local completion does not authorize:

- any Meta or other provider call;
- a test-number/Page send;
- token creation, replacement, inspection, or permission change;
- deployment or worker enablement;
- public route expansion;
- production WhatsApp/Page changes; or
- production or customer traffic.

P6 may package the worker but may not use live provider credentials. P7 owns
approved test-asset sends and outage/status evidence. P8 owns production
readiness and coexistence decisions.
