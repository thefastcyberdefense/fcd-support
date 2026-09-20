# Outbound Worker Operations Contract

Status: operational design only; no deployable worker entrypoint or service is
enabled in Phase 5

## Preconditions

Do not start outbound processing until P6 packaging and private operations pass,
P7 authorizes the exact test assets, and the runtime has protected credentials.
The worker must have private PostgreSQL access and outbound HTTPS to the approved
Meta host only. It must not join the public ingress network or expose a route.

Before enablement verify the exact approved revision, migration state, one
active reviewed policy, reviewed account-scoped templates, protected deployment
bounds, private health/alert path, manual coverage, and an explicit rollback.
Never print credentials or inspect their values for evidence.

## Start And Stop

Phase 5 cannot currently be started as a daemon: it provides library
composition but no worker command, container, scheduler, or deployment unit.
P6 must add those artifacts with a non-root user, read-only filesystem where
compatible, health check, resource limits, and private-only networking.

The future start procedure must enable claiming only after readiness checks.
The stop procedure must first stop new claims, allow bounded in-process calls to
finish within their configured timeout, then terminate. Killing after
`dispatch_started` is safe from blind resend: lease recovery closes the attempt
as `delivery_unknown`.

## Lease Recovery

Run bounded lease expiry only from the private worker role. Expired leased work
with no dispatch-started attempt can return to pending; an authorized attempt is
closed as abandoned before dispatch. A dispatch-started attempt becomes
delivery unknown and creates one content-free escalation. Never manually change
intent/attempt rows or requeue an unknown delivery.

## Unknown-Delivery Review

An operator reviews only the internal intent/attempt reference, channel enum,
timestamps, closed outcome/reason, and aggregate status evidence. Do not expose
message content, recipient, provider message ID, request/response body, token,
or provider error detail in alerts or tickets. Resolve through an approved
human workflow; never trigger an automatic resend. If a later signed delivery
or read status arrives, PostgreSQL may correct the projection monotonically.

## Privacy And Retention Operations

Deletion, marketing opt-out, and retention run through their authoritative
commands, not ad-hoc SQL. They cancel eligible work in the same transaction,
preserve append-only content-free evidence, and never recall an already accepted
provider message. Re-opt-in creates new consent authority only; it cannot revive
a canceled intent.

## Aggregate Monitoring

Phase 6 monitoring may report counts and age distributions for pending/leased,
lease expiry, provider accepted, delivery unknown, terminal failure,
cancellation reason, rate denial, status progression, and open escalation.
Logs and alerts must exclude content, raw/external identity, provider message
ID, URL/query, headers, credentials, payloads, and exception detail.

Stop claiming and use manual Business Suite coverage if policy authority is
missing/ambiguous, PostgreSQL is unavailable, sanitized alerting is unavailable,
provider behavior is uncertain, or a privacy/takeover invariant fails.
