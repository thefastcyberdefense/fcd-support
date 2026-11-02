# Outbound Worker Operations Contract

Status: Implemented in Phase 6 runtime packaging; entrypoint and worker service
remain disabled in `--mode private-disabled` until Phase 7 authorizes live
Meta test assets.

## Preconditions

Do not enable outbound processing until Phase 6 packaging and private operations
gates pass, Phase 7 authorizes the exact Meta test number/assets, and the runtime
receives protected credentials. The worker requires private PostgreSQL access
and outbound HTTPS to the approved Meta host only. It must not join the public
ingress network or expose any host or HTTP route.

Before enablement, verify the exact approved revision, migration state, one
active reviewed policy, reviewed account-scoped templates, protected deployment
bounds, private health/alert path, manual coverage, and an explicit rollback plan.
Never print credentials or inspect their values for evidence.

## Start And Stop

In Phase 6, the worker entrypoint is implemented in `dist/worker-main.js outbound`
(along with `reply` and `notification` roles). The container runs as non-root
user `1000:1000`, with a read-only root filesystem (`read_only: true`), all Linux
capabilities dropped (`cap_drop: [ALL]`), `no-new-privileges: true`, explicit
CPU/memory/PIDs limits, health checks, and connection to the private data network
`fcd-support-private` only.

The start procedure enables claiming only after PostgreSQL readiness checks pass.
The stop procedure executes graceful worker drain (`scripts/operations-drain.sh`):
it first stops new job claims, allows in-flight calls to complete within their
configured timeout, and then terminates. Terminating after `dispatch_started`
is safe from duplicate sending: lease recovery transitions the attempt to
`delivery_unknown` rather than blindly re-dispatching.

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
