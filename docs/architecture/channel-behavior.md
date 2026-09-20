# Meta Channel Behavior Contract

Status: Messenger behavior and the WhatsApp test-number/coexistence separation
were approved by the project owner on 2026-08-26 and documented under tracker
rows `P0-007` and `P0-008`. Coexistence capability remains test-gated.

## Purpose And Scope

This document defines how admitted Meta events affect conversation authorship,
automated replies, and the 24-hour human-takeover pause. It complements the
[webhook admission contract](webhook-admission.md), which remains authoritative
for signatures, acknowledgement, persistence, idempotency, staleness, and
future-skew handling.

This revision closes only Messenger human-reply detection and loop prevention.
It does not infer WhatsApp coexistence behavior, authorize outbound messaging,
or change any production Meta asset.

## Closed Normalized Event Boundary

The initial channel-neutral event kinds are:

- `customer_message`: customer-authored content eligible for later policy
  processing;
- `business_message_echo`: a message sent by the business identity and echoed
  by Meta;
- `message_status`: a bounded sent, delivered, read, or failed update;
- `unsupported`: a recognized but unimplemented or invalid item that has no
  automated side effect.

Each valid batch item is normalized independently. An unsupported or malformed
item does not discard valid siblings. Unsupported items never call a model,
enqueue an outbound message, change consent, or pause or resume AI.

## Messenger Mapping

Messenger uses a Page envelope with `object: "page"`, one or more `entry[]`
objects, and zero or more `entry[].messaging[]` items. The implemented mapping is:

| Messenger input | Normalized result | Identity and ordering |
|---|---|---|
| Text `message` without `message.is_echo === true` | `customer_message` | Page from `entry.id`; contact from `sender.id`; provider message from `message.mid`; provider time from `timestamp` |
| Text `message` with `message.is_echo === true`, received through the `message_echoes` subscription | `business_message_echo` | Page from `entry.id`; contact from `recipient.id`; provider message from `message.mid`; provider time from `timestamp` |
| Delivery notification with non-empty stable `delivery.mids[]` | One canonical `delivered` `message_status` per `mid` | Page and recipient scope plus watermark provider time; exact provider-message correlation is required before state advances |
| Read-watermark-only or delivery without a stable `mid` | `unsupported` | No guessed range correlation or outbound state change |
| Reaction, edit, postback, attachment-only message, or unknown shape not yet implemented | `unsupported` | No reply or policy side effect |

Messenger message and echo idempotency is
`messenger:message:<page-id>:<message-mid>`. Sender/recipient direction alone is
not evidence of a human reply: `message.is_echo === true` and a valid
`message.mid` are required for the current business-echo mapping.

Meta documents `messages` as customer-to-business notifications and
`message_echoes` as notifications that the business sent a message. An echo
therefore proves business authorship, but does not by itself prove whether the
author was a staff member or this service.

## Human Reply And Pause Rules

An admitted Messenger `business_message_echo` is handled as follows:

1. Correlate it against the authoritative PostgreSQL outbound intent and stored
   provider-message identity when such an outbound record exists.
2. If the correlation proves the service sent the message, classify it as a
   service self-echo. Record the correlation or delivery evidence idempotently,
   but do not pause AI and do not create another reply.
3. If no service-outbound correlation can be proven, treat it as a human or
   other business-authored reply. Pause the matching conversation until the
   later of its current deadline and `occurred_at + 24 hours`.

Correlation uses durable identifiers associated with the outbound intent and
provider response. Message text, display names, sender/recipient direction,
timing proximity, and process memory are insufficient. Phase 5 implements a
bounded PostgreSQL correlation hold at dispatch start; until an exact provider
ID exists, a candidate service echo remains pending only within that hold.

The provider event timestamp is authoritative for the deadline. An exact retry
or logical duplicate cannot append another pause or extend the deadline. A
distinct later business echo may extend the deadline; an older echo cannot
shorten it. A business echo at or before `last_authorized_resume_at` cannot
reinstate a pause, while a genuinely later echo starts a new 24-hour pause.

An authorized resume remains a private, authenticated operation. It is never
available through the public Meta callback or Cloudflare Tunnel.

## Loop And Race Prevention

- A business echo never calls the model and never creates an outbound reply.
- A correlated self-echo never activates or extends human takeover.
- An uncorrelated echo fails safe by pausing automation; it is never guessed to
  be service-authored.
- PostgreSQL receipt and event uniqueness make delivery retries successful
  no-ops.
- Events rejected as stale or unsupported by the admission contract cannot
  trigger takeover.
- Reply eligibility is checked immediately before creating an outbound intent
  and again immediately before provider send. An earlier cached result cannot
  authorize a later send.
- Phase 5 tests both provider-response/echo orders and the staff-echo/dispatch
  race. Open holds block another send; exact provider-ID correlation closes a
  self-echo; unknown, expired, text-only, or mismatched echoes pause automation.

## Current Implementation And Evidence

The local normalizer already maps Messenger text messages and
`message.is_echo === true` items separately, derives the Page/contact direction
shown above, and uses the Page-plus-`mid` idempotency key. The Phase 3 policy
core already applies unmatched echoes exactly once, uses provider time for the
24-hour deadline, and implements duplicate, resume, expiry, and concurrency
rules.

Phase 5 adds exact-scope monotonic delivery projection and the bounded
Messenger echo hold described above. Its local evidence covers eleven
correlation cases without a live Page send. Deployed worker and test-Page
evidence remains P7-005.

On 2026-08-26, a role-scoped customer message and a manual reply from the
dedicated Messenger test Page reached durable ingestion through the restricted
callback. The second event was normalized as a business echo. The deployed
runtime is admission-only and does not run the asynchronous Phase 3 processor,
so that evidence proves echo detection and durable ingestion, not live
echo-to-pause application.

## WhatsApp Test-Number And Coexistence Boundary

Messenger `message_echoes` behavior is not evidence for WhatsApp. The standard
Cloud API test number and a production number using WhatsApp Business App
coexistence have separate capabilities and evidence requirements.

### Standard Cloud API And Test-Number Mapping

A standard WhatsApp webhook uses `object: "whatsapp_business_account"`, one or
more `entry[].changes[]` items, and `field: "messages"`. Each supported item is
normalized independently:

| WhatsApp input | Normalized result | Policy effect |
|---|---|---|
| Inbound text in `value.messages[]` | `customer_message` | May enter later reply policy after durable admission |
| `sent`, `delivered`, `read`, or `failed` item in `value.statuses[]` | `message_status` | Updates only correlated outbound delivery state; never proves a staff reply and never pauses AI |
| Unsupported message type, malformed item, or unknown change field | `unsupported` | No model, outbound, consent, or takeover side effect |

For inbound text, `value.metadata.phone_number_id` scopes the business channel
identity and `messages[].id` supplies the provider message identity. A non-empty
`messages[].from` remains the preferred customer identity. When v26 omits it
and supplies `messages[].from_user_id`, the namespaced
`user_id:<from_user_id>` identity is used. Statuses use their provider message
ID, recipient identity, status, and timestamp as defined by the webhook
admission contract.

The Meta-hosted test number validates standard Cloud API callback admission,
normalization, and status handling. It does not run the production WhatsApp
Business App and cannot prove coexistence, manual-app reply mirroring, history
synchronization, or production-number eligibility.

### Coexistence And Manual-App Echo Gate

A coexistence-specific manual-app signal such as `smb_message_echoes` is an
unproven optional input. It must remain `unsupported` until all of these
conditions are satisfied:

1. Meta's current official contract or a signed, sanitized capture from an
   approved non-production coexistence asset proves the exact envelope, author
   identity, contact identity, provider message identity, and timestamp.
2. Sanitized fixtures cover valid, malformed, duplicate, stale, future-skewed,
   batched, and out-of-order forms without customer data.
3. Tests prove channel-specific idempotency and that valid siblings survive an
   unsupported or malformed sibling.
4. Tests distinguish a staff-authored WhatsApp Business App message from a
   service-originated Cloud API message using durable provider identifiers,
   never text, display names, timing guesses, or process memory.
5. The test-asset acceptance record proves the signal arrives after an actual
   manual reply and that an exact retry causes no second side effect.

Once those gates pass, an uncorrelated, proven manual-app echo may normalize to
`business_message_echo` and use the same PostgreSQL-backed 24-hour pause rules
as Messenger: provider event time sets the deadline, duplicates do not extend
it, older events cannot reverse a later resume, and a genuinely later staff
reply starts a new pause.

A WhatsApp echo correlated to an authoritative service outbound intent is a
self-echo. It may update outbound correlation or delivery evidence but never
pauses AI and never creates another reply. A standard `statuses[]` item is also
not a human-reply signal.

### Evidence And Production Stop Rule

On 2026-08-26, Meta's v26.0 webhook tester proved signed synthetic inbound and
status delivery to the restricted callback. A signed current-time synthetic
v26 text event also proved phone-unavailable `user_id:` normalization and exact
retry deduplication. A real device-originated message to the Meta test number
did not reach the callback while the app remained unpublished. These results
prove only the behaviors named here; they do not prove live customer delivery,
coexistence, or manual-app echo behavior.

Production-number coexistence eligibility is a later read-only Phase 8 check.
No production number may be changed, linked, unlinked, migrated, registered, or
subscribed to obtain this evidence. If coexistence is unavailable, or if a
manual WhatsApp Business App reply cannot produce the tested takeover signal,
production-number work stops and requires a separate migration or operating
model decision.

## Primary Platform Reference

- [Meta Messenger Platform webhook collection](https://www.postman.com/meta/messenger-platform-api/folder/22794852-b5d97624-14d8-4e67-a2e4-529add49ca58)
  describes Page webhook envelopes, the `messages` and `message_echoes` fields,
  signatures, retry behavior, and timestamp ordering.
- [Meta WhatsApp Business Platform webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/vzaxn16/webhook-payload-reference)
  describes the standard WhatsApp Business Account envelope, `messages` field,
  inbound messages, and outbound status updates. It is not treated as evidence
  of coexistence-specific manual-app echoes.
