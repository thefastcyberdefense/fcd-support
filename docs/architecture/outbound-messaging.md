# Phase 5 Outbound Messaging Architecture

Status: local implementation complete; live provider execution remains gated

Reviewed: 2026-09-20 (Asia/Dhaka)

## Authority And Scope

PostgreSQL is authoritative for outbound policy, fixed-template review,
intent state, attempt evidence, rate reservations, provider status, Messenger
echo holds, and escalation outcomes. Meta, Manifest, n8n, OpenClaw, and Hermes
cannot create or rewrite authoritative outbound state.

Phase 5 supplies library composition and local-fake evidence. It does not add a
public route, worker process, container, live credential, provider send, or
deployment. Phase 6 owns private worker packaging and operations; Phase 7 owns
approved test-asset sends.

## Durable State Machine

One `outbound_intents` row exists per logical reply draft or reviewed fixed
template request. Intent authority—conversation, identity, channel/account,
policy, draft/template, purpose, and retention deadline—is immutable.

| State | Meaning | Automatic next states |
|---|---|---|
| `pending` | Eligible for a bounded worker claim | `leased`, `canceled`, `terminal_failed` |
| `leased` | Owned by one process-issued lease | `pending` only before dispatch; otherwise accepted, unknown, failed, or canceled |
| `provider_accepted` / `sent` | Provider accepted; recall is impossible | monotonic delivery/read or terminal provider failure |
| `delivered` / `read` | Confirmed terminal delivery projection | `delivered` may advance to `read` only |
| `delivery_unknown` | Dispatch may have reached the provider | terminal; never automatically retried |
| `terminal_failed` / `canceled` | Closed without an eligible automatic send | terminal, except later signed delivery/read may correct a provider-failure projection |

An attempt is authorized only under a live lease. `dispatch_started` is
committed before provider I/O. A crash before that boundary can safely return
work to pending; a crash, timeout, malformed response, or transport ambiguity
after that boundary becomes `delivery_unknown` plus one content-free human
escalation. This at-most-once bias prevents blind duplicate customer messages.

## Reviewed Policy And Limits

Policy and zero-variable WhatsApp templates use immutable version rows plus
append-only submit, approve, activate, and retire evidence. Exactly one policy
version may be active. Values have no database defaults and remain explicitly
customizable:

- linked-contact 15-minute and 24-hour limits;
- WhatsApp-account and Messenger-account one-minute limits;
- global one-minute and UTC-day limits;
- worker batch, lease, and provider-timeout bounds;
- definite-rejection retry count and exponential backoff bounds.

Effective values are the stricter intersection of reviewed policy and protected
deployment bounds. Contact limits follow the authoritative linked contact
across channels. Reservations and eligibility checks occur in the same bounded
transaction as attempt authorization.

## Enqueue And Send-Time Checks

Enqueue and final authorization independently fail closed for missing policy,
human pause, open Messenger echo hold, privacy workflow, verified deletion,
suppression, missing exact marketing consent, Meta's 24-hour support window,
inactive or mismatched template, retention expiry, active-client review expiry,
and erased/unready content. Channel-specific text size is checked before an
attempt is created.

FAQ and model drafts use the same outbound path. Their origin does not weaken
send-time policy. Marketing uses only reviewed, active, fixed zero-variable
WhatsApp templates whose account, category, and locale exactly match the
intent.

## Provider Boundary

Process-issued request objects alone can reach the Meta adapter. Builders fix
Graph API `v25.0`, production host `https://graph.facebook.com`, account-scoped
paths, closed channel payloads, and exact text/template forms. The adapter:

- makes one non-redirecting request per dispatched attempt;
- enforces total timeout, caller abort, and bounded response bytes;
- accepts only strict channel-specific success JSON;
- classifies reviewed definite 400/429 outcomes separately from ambiguous
  transport, timeout, redirect, oversized, or malformed responses;
- never logs or returns credential values, response bodies, recipients, or
  provider error detail.

Local adapter evidence uses loopback only and obvious synthetic credentials.
No live Meta call has occurred.

## Status And Messenger Echo Correlation

WhatsApp and Messenger status events correlate only by exact channel,
channel-account, and provider-message identifier. Append-only status evidence
advances `provider_accepted < sent < delivered < read`; lower-ranked or failed
events cannot downgrade delivery, while later delivered/read evidence may
correct an earlier failure projection.

At Messenger dispatch start, PostgreSQL opens one bounded correlation hold for
the locked conversation. The hold lifetime uses the effective customizable
provider timeout. An exact provider-ID echo becomes
`service_echo_correlated`; unknown, expired, text-only, or mismatched echoes
use the existing provider-time human pause. Open holds block later enqueue and
dispatch. Conversation-first locking makes the dispatch/staff-echo race
deterministic without message-text guessing.

## Privacy And Retention

Deletion, all-linked marketing opt-out, and retention lock identities,
conversations, intents, and active attempts in ascending internal-ID order.
Pending, leased, and authorized-before-dispatch work is canceled with a closed
reason; authorized attempt evidence becomes `abandoned_before_dispatch`.
`dispatch_started` becomes `delivery_unknown`, creates one content-free
escalation, and is never requeued. Provider-accepted or delivered messages
cannot be recalled.

Dependent drafts are erased while content-free attempts and status evidence
remain append-only. Deletion completes `pending_outbound` only after the same
transaction reconciles outbound work. Re-opt-in never resurrects terminal
canceled intents. Retention advances only `content_purged_through_at`; it does
not move lifecycle anchors. Subject access remains the existing fixed
allowlist and excludes outbound leases, attempts, provider IDs, request keys,
and provider details.

## Observability Boundary

Permitted operational facts are aggregate queue depth, state/reason counts,
lease expiry counts, duration, channel enum, and internal opaque references.
Message text, recipient identifiers, provider message IDs, payloads, URLs,
headers, tokens, SQL parameters, and exception/provider body detail are not
operational telemetry. Phase 6 must implement sanitized alert delivery before
any worker can be enabled.
