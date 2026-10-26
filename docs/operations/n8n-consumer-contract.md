# Private notification consumer contract

Phase 6 Task 14 implements local delivery to a separately managed private n8n
consumer. Production execution remains `N8N_EXECUTION_ENABLED=false`. This
document does not authorize a live workflow edit, credential creation, network
attachment, or enablement. The existing n8n operator must implement and validate
the receiving contract before a separately approved connection.

## Boundary and configuration

Only the notification worker joins the dedicated private notification network.
That network must have no route to the public Internet. Do not publish n8n or
create an application callback route. The consumer receives no PostgreSQL
credential and cannot change conversation, consent, privacy-review, AI pause,
outbound delivery, or escalation authority. A delivery acknowledgement only
settles notification work.

The worker requires one exact origin and path. Production origins use an HTTP
or HTTPS private service alias consisting of a single DNS label. URL
credentials, query strings, fragments, IP literals, external hostnames and
redirects are refused. All DNS answers must be private RFC 1918 or IPv6 unique
local addresses. Each fresh connection pins one validated answer, checks its
connected peer before sending headers or body, and discards the connection
afterward. Mixed private/public answers, link-local addresses and destination
substitution fail closed. IPv4 loopback and IPv6 loopback are available only
with the explicit synthetic flag in a test runtime. Injected transports are
also restricted to synthetic mode; production uses the socket-checking client.

Supply these protected settings explicitly when enabling delivery. Blank
values below are placeholders, and an enabled runtime rejects them. The
existing mounted-secret loader reads the signing secret; do not place its
contents in environment examples or command output.

```dotenv
N8N_EXECUTION_ENABLED=false
N8N_ORIGIN=
N8N_PATH=
N8N_ESCALATION_WEBHOOK_SECRET_FILE=
N8N_PROVIDER_TIMEOUT_MS=
N8N_MAX_RESPONSE_BYTES=
N8N_MAX_ATTEMPTS=
N8N_RETRY_BASE_MS=
N8N_RETRY_MAXIMUM_MS=
N8N_ALLOW_LOOPBACK_FAKE=false
```

Timeout, response byte limit, attempts, base delay, maximum delay, batch size,
lease, poll and shutdown bounds have no implicit business defaults. Runtime
configuration validates them before constructing a database pool. The n8n
timeout must not exceed `OPS_MAX_CALL_MS`; the lease and process stop bounds
must exceed the configured call and shutdown grace. Each authorization also
requires enough lease and source retention time for the entire bounded call.
Attempt caps and backoff are PostgreSQL policy inputs. Backoff is
`min(retryMaximumMilliseconds, retryBaseMilliseconds * 2^(attemptNumber-1))`.
The implementation's numeric ceilings reject unsafe configurations; they do
not replace the operator's supplied policy.

## Request and authentication

The request is `POST` to the configured exact path with `application/json` and
exactly five keys in this order:

```json
{
  "schemaVersion": 1,
  "type": "operator_support_escalation",
  "reference": "NOTIFICATION_TEST_synthetic",
  "occurredAt": "2030-04-01T00:00:00.000Z",
  "idempotencyKey": "NOTIFICATION_TEST_synthetic"
}
```

The actual signed bytes use compact JSON without whitespace or a trailing
newline, encoded as UTF-8. This example is newly authored synthetic data.
`occurredAt` is an ISO UTC timestamp with milliseconds. Opaque reference and
idempotency key use `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Allowed types are
`operator_privacy_request`, `operator_marketing_opt_out`,
`operator_support_escalation`, and `operator_outbound_escalation`. No customer
text, name, channel identity, provider ID, correction value, export, prompt or
arbitrary error is allowed. Reject extra fields and unsupported versions.

The headers are:

- `X-FCD-Timestamp`: decimal integer Unix seconds, generated for this attempt.
- `X-FCD-Signature`: `sha256=` followed by the lowercase hexadecimal HMAC.
- `Idempotency-Key`: exactly the envelope's idempotency key.

The HMAC is SHA-256 with the dedicated signing secret over the concatenation
of the timestamp's ASCII bytes, one literal `.` byte, and the unmodified
canonical body bytes. The same durable work keeps its body, reference,
occurrence time and key across retries; the signing timestamp is refreshed.

Before parsing or recording a request, the receiving workflow must enforce a
configured body byte limit, require a valid decimal signing timestamp, and
reject both expired and future timestamps outside its explicitly configured
maximum clock skew. Check the signature prefix/hex length, decode it, and use
constant-time comparison with the independently computed HMAC. A signature
over reserialized JSON does not authenticate the received bytes. After MAC
verification, require the strict shape, canonical serialization, supported
type, valid timestamp and matching header/body key. Clock synchronization and
the skew allowance are receiving-operator responsibilities. Do not store
invalid request bodies or authentication headers.

## Durable acceptance and deduplication

The consumer needs a durable inbox with a unique constraint on the idempotency
key, plus a transactional notification outbox or equivalent durable workflow
state. In one transaction, insert the key with a fingerprint of its authenticated
canonical body and enqueue the staff notification once. Commit before
acknowledging acceptance. A concurrent duplicate or a retry after a lost
acknowledgement returns acceptance for the existing key without creating a
second notification. Reuse of a key with different authenticated body bytes is
a terminal conflict. An in-memory map or execution-history lookup is
insufficient for a real consumer.

Return a successful HTTP status only after this durable acceptance. The body
must contain exactly the following two fields, with the matching key:

```json
{ "accepted": true, "idempotencyKey": "NOTIFICATION_TEST_synthetic" }
```

Staff-delivery retries must use the same durable key. A downstream adapter
must support idempotency, or its ambiguous outcomes require operator review;
workflow retries alone cannot prove exactly-once external delivery. Preserve
deduplication across consumer restarts and backups. Do not expire a key while
its source can remain eligible or while any retry, lease recovery or approved
recovery could replay it. The five-field envelope does not convey source
retention deadlines, so the operator must establish a compatible minimal-key
retention policy before enablement. This implementation adds no new customer
content retention policy.

Disable or minimize receiving execution/body/header recording and logging.
Retain only the required opaque key/fingerprint, closed shape/outcome metadata,
and delivery state under that reviewed policy. Never copy incoming payloads,
signatures or signing secrets into runbooks, diagnostics or logs.

## Sender outcomes and recovery

Success requires a bounded UTF-8 JSON acknowledgement with `accepted=true`,
the exact matching key and no extra fields. Error bodies are never read or
logged. Redirects and destination violations are terminal
`destination_rejected`; HTTP 401/403 is terminal `authentication_failed`.
Other non-transient 4xx responses are terminal `invalid_response`. HTTP
408/429/5xx, transport ambiguity, caller cancellation, malformed or oversized
success and timeout are retried with bounded closed reasons. The total deadline
includes DNS, connection, response headers and acknowledgement body reading.

PostgreSQL owns pending work, leases, next-attempt times, attempt counts,
append-only attempts, delivery and failure outcomes. Before each send it
rechecks the owned lease, source existence, source/stored retention deadlines,
notification type/time, restore quarantine and recovery holds. Deletion erases
delivery work through the existing erasure path; a cached claim cannot
authorize sending afterward. A lost settlement remains unsettled until lease
recovery and uses the same key. n8n outages cannot mutate consent or
conversation authority and do not block core support state processing.

## Required local evidence before connection

The synthetic loopback receiver accepts only a newly authored synthetic signing
secret and records shape/outcome counts and synthetic key fingerprints. Unit
and PostgreSQL flow tests cover canonical signing, exact acknowledgements,
clock skew, bad signatures, mutation, strict shape, deduplication after lost
acknowledgement, unsafe destinations, timeouts, bounded responses, attempt
caps, authority preservation, post-claim expiry/quarantine/lease checks and
verified deletion. The receiving operator must independently demonstrate
durable concurrent deduplication and restart recovery before enablement. No
live n8n workflow or external provider is changed by these tests.
