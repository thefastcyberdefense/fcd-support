# Project Sequencing And Readiness Design

Date: 2026-08-11
Status: Approved for documentation

## Objective

Turn the original direction-level plan into a gate-driven delivery sequence that shows what can be built safely, what evidence proves each step, and where operator approval is required. This design changes planning and tracking only; it does not authorize application code, deployment, public DNS, Meta asset changes, live customer data, or production-number work.

## Audit Findings

The original plan established strong safety constraints but could not drive implementation reliably:

1. The handover referenced Phase 0 although the plan defined no phases.
2. WhatsApp and Messenger were grouped together despite different envelopes, echo events, message identifiers, and manual-reply behavior.
3. Signature verification did not explicitly require unmodified raw bytes before parsing.
4. Durable receipt, acknowledgement timing, retry behavior, idempotency, concurrency, stale-event outcomes, and out-of-order status handling were not specified.
5. Human takeover assumed manual replies would be observable without separating Messenger echo behavior from WhatsApp coexistence behavior.
6. Retention, deletion, Manifest recordings, backup restoration, and suppression records lacked one consistent lifecycle.
7. Active-client retention was not concrete enough to test or approve.
8. Blank marketing consent was represented by a configuration switch even though it is a non-configurable safety rule.
9. Cloudflare path restriction was not tied to a validated terminal 404 ingress rule and negative-route tests.
10. There was no dependency tracker, evidence index, decision owner, external-action boundary, or phase exit review.

## Approaches Considered

### Minimal Plan Patch

Adding Phase 0 headings and a checklist would be quick, but it would leave dependencies and evidence distributed through prose. Reviewers could not reliably determine whether a gate had passed.

### Gate-Driven Plan And Tracker

Keep stable scope, constraints, and gates in `docs/PLAN.md`; keep live status, dependencies, owners, approvals, and evidence in `docs/TODO.md`. This is the selected approach because it makes unsafe ordering visible without turning the plan into a project-management system.

### Single Exhaustive Implementation Plan

Writing every code task now would create false precision across independent subsystems. Platform findings and policy decisions from early phases would force later tasks to be rewritten.

## Selected Sequence

The project advances through nine bounded states:

1. Phase 0 closes tooling, trust-boundary, channel, lifecycle, fixture, threat, and acceptance decisions.
2. Phase 1 builds the local TypeScript scaffold and webhook security core without a database or external service.
3. Phase 2 adds PostgreSQL durability, idempotency, acknowledgement behavior, and asynchronous processing.
4. Phase 3 implements conversation, human takeover, consent, retention, deletion, and suppression rules.
5. Phase 4 adds approved knowledge, redaction, the tool-free Manifest boundary, and bilingual evaluation.
6. Phase 5 adds the outbound outbox, channel adapters, eligibility checks, limits, and status correlation.
7. Phase 6 hardens containers, networks, migrations, backups, restores, monitoring, and private n8n notifications.
8. Phase 7 uses explicitly approved test assets to validate the complete system.
9. Phase 8 makes a production-readiness decision without modifying the production WhatsApp number.

Production promotion is a separate plan and approval. Passing Phase 8 does not authorize it.

## Architectural Ordering

The public trust boundary precedes infrastructure so signature, size, route, and parsing behavior can be proven with pure local tests. PostgreSQL follows immediately because durable deduplication cannot be proven with process memory. Policy decisions precede model and outbound work so the system never generates or sends a reply without deterministic pause, consent, retention, and deletion rules. Operations precede external test assets so public ingress is never connected to an unhardened stack.

Channel-specific adapters normalize into narrow internal event types. PostgreSQL owns accepted receipts and state transitions. Asynchronous processors consume durable events, consult deterministic policy and approved knowledge, optionally call the dedicated tool-free Harness, and write outbound intentions to an outbox. Provider workers re-check policy immediately before sending.

## Webhook Admission Contract

The implementation plan must preserve this order:

1. match the exact route and method;
2. enforce the encoded-body limit while retaining raw bytes;
3. validate the signature format and compare the HMAC in constant time;
4. parse and validate the JSON envelope;
5. normalize WhatsApp or Messenger events independently;
6. persist a minimal receipt and normalized event atomically using a channel-specific idempotency key;
7. acknowledge the documented outcome; and
8. process accepted work asynchronously.

Invalid signatures never reach parsing or storage. Duplicates, stale events, unsupported events, database failures, and malformed envelopes each require an explicit response and audit rule in Phase 0. A successful acknowledgement must never claim that unpersisted work was accepted.

## Human Takeover Contract

Messenger business echo events and WhatsApp coexistence/manual-app echoes are distinct integrations. Both may normalize to a business-authored event, but WhatsApp support remains unproven until test-asset validation. A business-authored event pauses the conversation for 24 hours. Outbound creation and sending each re-check the pause to close concurrency races. Resume is authenticated and private.

## Lifecycle Contract

Casual-chat and unconverted-lead retention are fixed at 60 days and 12 months, respectively. Phase 0 must select exact lifecycle anchors and define reclassification. Active-client retention requires a named business/legal owner and exact rule before production readiness. Verified deletion is idempotent and covers live PostgreSQL state plus applicable Manifest recordings. A deletion ledger or an equally reviewed mechanism prevents restored backups from resurrecting deleted content. Minimal opt-out suppression retains only approved fields for an approved period.

## Primary Platform Evidence

- Meta's official Messenger webhook collection documents SHA-256 payload signatures, the response deadline, and `message_echoes`: <https://www.postman.com/meta/messenger-platform-api/folder/22794852-b5d97624-14d8-4e67-a2e4-529add49ca58>.
- Meta's official WhatsApp collection documents the webhook envelope and message identifiers: <https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference>.
- Meta's WhatsApp status example warns that notification order may differ from event time: <https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications>.
- Cloudflare requires a final catch-all ingress rule and provides validation/rule-test commands: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/>.
- Manifest documents its OpenAI-compatible endpoint and `model: "auto"` routing: <https://github.com/mnfst/manifest>.

## Tracker Model

Every row in `docs/TODO.md` has:

- a stable task ID;
- dependencies;
- an accountable role;
- a status;
- a completion rule or evidence location; and
- an approval boundary.

Blocked later-phase rows are intentional: they make dependencies visible and do not imply active work. Evidence must be synthetic or sanitized and must never contain credentials, identifiers, raw payloads, customer content, dumps, or recordings.

## Development Readiness

Application development is ready to begin only after:

- the written sequencing documents are reviewed;
- all tasks required by the Phase 0 gate are complete;
- the Phase 1 implementation plan is written and approved; and
- no external action is needed for the first local test-first task.

The initial development increment is the local webhook security core. PostgreSQL durability is the immediately following increment and must pass before the webhook service can be considered operationally acceptable.
