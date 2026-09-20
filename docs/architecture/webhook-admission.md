# Meta Webhook Admission Contract

Status: implemented for the local security and durable-ingestion path. The time
thresholds remain revisable before production if sanitized Meta test-asset evidence
requires a change.

## Trust-Boundary Order

The request path is fixed:

```text
exact route and method
-> application/json and encoded body <= 256 KiB
-> unmodified raw Buffer
-> X-Hub-Signature-256 syntax and constant-time HMAC-SHA256 comparison
-> strict UTF-8 and JSON parsing
-> channel-specific envelope normalization
-> atomic PostgreSQL receipt and normalized-event transaction
-> HTTP acknowledgement
-> later asynchronous processing
```

Invalid signatures never reach parsing or storage. The acknowledgement path does
not call a model, Meta Graph, n8n, Manifest, OpenClaw, or Hermes. A successful
event acknowledgement is sent only after PostgreSQL commits the minimal receipt.
The local admission target is five seconds; database connection acquisition is
bounded to 750 milliseconds and each transaction is limited to 3.5 seconds, with
shorter lock and statement limits. An unavailable durable sink returns `503`. Phase 6
must validate the end-to-end timeout at the container and ingress layers before
any test-asset deployment.

## HTTP And Side-Effect Matrix

| Input or durable outcome | HTTP | Durable record | Automated side effect |
|---|---:|---|---|
| Valid GET verification | `200` challenge | None | None |
| Invalid GET mode, token, or challenge | `403` | None | None |
| Unknown route or wrong method | `404` | None | None |
| Missing or invalid signature | `401` | None | None |
| Wrong content type, malformed UTF-8, or malformed JSON | `400` | None | None |
| Encoded body over 256 KiB | `413` | None | None |
| Accepted new event | `200` | Receipt and normalized event | Async processing may follow |
| Exact payload duplicate | `200` | Existing receipt only | None |
| Logical event duplicate in a different payload | `200` | New receipt; existing event only | None |
| Stale or unsupported event | `200` | Minimal outcome | None |
| PostgreSQL unavailable before commit | `503` | None guaranteed | None |

Every event in a valid batch is normalized independently. An unsupported sibling
does not discard supported siblings. Raw webhook bodies are fingerprinted in
memory with SHA-256 but are not stored.

## Idempotency Keys

Keys never include message text:

| Channel event | Key |
|---|---|
| WhatsApp inbound text | `whatsapp:message:<message-id>` |
| WhatsApp status | `whatsapp:status:<message-id>:<status>:<provider-timestamp>` |
| Messenger message or echo | `messenger:message:<page-id>:<message-mid>` |
| Messenger delivery with stable `mid` | `messenger:delivery:<page-id>:<peer-id>:<event-timestamp>:<canonical-subset-sha256>` |
| Unsupported item | `meta:unsupported:<payload-sha256>:<batch-index>` |

Each implemented Messenger delivery item requires non-empty stable `mids[]` and
normalizes to one status per `mid`. Read-watermark-only and missing-`mid`
delivery items remain unsupported rather than guessing range correlation. The
canonical hash contains only documented identifiers, kind, and timestamp—never
user content.

## WhatsApp v26 Identity Compatibility

For an inbound text message, a non-empty `messages[].from` phone identity remains
authoritative. When v26 omits that field but provides a non-empty
`messages[].from_user_id`, the normalizer uses `user_id:<from_user_id>` as the
contact identity. The prefix prevents a provider user ID from colliding with a
phone-based identity. When both forms are present, the phone identity wins so an
existing conversation is not split.

Profile usernames and parent-user identifiers are not persisted by this mapping.
Contact-card messages remain unsupported and their embedded contact details are
not emitted as normalized event fields.

`webhook_receipts.payload_sha256` rejects exact delivery retries. The unique
`webhook_events.idempotency_key` rejects logical event retries across different
payloads. Both constraints are authoritative under concurrent delivery.

## Event Time And Ordering

- `received_at` is server time and is stored separately from provider `occurred_at`.
- Customer messages and business echoes more than five minutes old at first receipt are recorded as `stale` and cannot trigger automated effects.
- Status events are not made stale solely because of age. They remain available for later monotonic status correlation.
- Events more than 60 seconds in the future are recorded as `unsupported` with reason `event_time_too_far_future` and cannot trigger automated effects.
- Out-of-order statuses are stored independently. The Phase 5 status repository correlates exact channel/account/provider IDs and applies monotonic precedence without rolling state backward.

## Durable Boundary

One transaction inserts the receipt and all normalized events. Any failed event
insert rolls back the complete receipt. Exact and logical duplicates are
successful no-ops. The HTTP path never claims success for a transaction that
throws or cannot acquire a database connection.

Integration evidence is in `tests/integration/migrations.test.ts`,
`tests/integration/postgres-receipt-store.test.ts`, and
`tests/integration/durable-runtime.test.ts`.
