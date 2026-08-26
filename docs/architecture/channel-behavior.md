# Meta Channel Behavior Contract

Status: Messenger behavior approved by the project owner on 2026-08-26 and
documented under tracker row `P0-007`. WhatsApp coexistence and manual-app echo
behavior remains deliberately unresolved under `P0-008`.

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
objects, and zero or more `entry[].messaging[]` items. The initial mapping is:

| Messenger input | Normalized result | Identity and ordering |
|---|---|---|
| Text `message` without `message.is_echo === true` | `customer_message` | Page from `entry.id`; contact from `sender.id`; provider message from `message.mid`; provider time from `timestamp` |
| Text `message` with `message.is_echo === true`, received through the `message_echoes` subscription | `business_message_echo` | Page from `entry.id`; contact from `recipient.id`; provider message from `message.mid`; provider time from `timestamp` |
| Delivery or read notification | Reserved `message_status` mapping | Must use its documented peer identity, provider time, and stable or canonical fallback key before it may update outbound state |
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

Correlation must use durable identifiers associated with the outbound intent
and provider response. Message text, display names, sender/recipient direction,
timing proximity, or process memory are not sufficient. Phase 3 has no outbound
provider path, so its admitted Messenger echoes are currently unmatched and
are intentionally processed as business replies. Phase 5 must add correlation
before it enables service-originated Messenger sends.

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
- Phase 5 must test the race between provider-send correlation and echo
  processing. It must not enable Messenger outbound delivery until a
  service-originated echo can be distinguished without using message content.

## Current Implementation And Evidence

The local normalizer already maps Messenger text messages and
`message.is_echo === true` items separately, derives the Page/contact direction
shown above, and uses the Page-plus-`mid` idempotency key. The Phase 3 policy
core already applies unmatched echoes exactly once, uses provider time for the
24-hour deadline, and implements duplicate, resume, expiry, and concurrency
rules.

On 2026-08-26, a role-scoped customer message and a manual reply from the
dedicated Messenger test Page reached durable ingestion through the restricted
callback. The second event was normalized as a business echo. The deployed
runtime is admission-only and does not run the asynchronous Phase 3 processor,
so that evidence proves echo detection and durable ingestion, not live
echo-to-pause application.

## Deferred WhatsApp Boundary

Messenger `message_echoes` behavior is not evidence for WhatsApp. WhatsApp test
number delivery and production coexistence/manual-app echo behavior use
different contracts. Their mapping, evidence requirements, and pause behavior
remain pending under `P0-008`; no production-number assumption is created by
this document.

## Primary Platform Reference

- [Meta Messenger Platform webhook collection](https://www.postman.com/meta/messenger-platform-api/folder/22794852-b5d97624-14d8-4e67-a2e4-529add49ca58)
  describes Page webhook envelopes, the `messages` and `message_echoes` fields,
  signatures, retry behavior, and timestamp ordering.
