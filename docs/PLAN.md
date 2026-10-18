# Fast Cyber Defense Support Delivery Plan

## Purpose And Status

This document defines the approved delivery sequence and the gate that ends each phase. `docs/TODO.md` is the live task tracker and evidence index. The Phase 0 planning gate passed on 2026-08-27; this does not clear later implementation, test-asset, production-readiness, or production-action gates.

The service will be a dedicated, self-hosted TypeScript application for WhatsApp Business Cloud API and Facebook Messenger. PostgreSQL is authoritative. The dedicated Manifest Harness `fcd-support` is the only model gateway and receives `model: "auto"`. Private n8n workflows may send notifications or perform later CRM actions, but they never own conversation, consent, or delivery state.

## Non-Negotiable Boundaries

- OpenClaw and Hermes stay outside the public customer-support execution path and their credentials are never reused.
- The production WhatsApp number must not be changed, unlinked, migrated, re-registered, or subscribed without explicit approval. Development uses a Meta test number first.
- If coexistence or manual-reply mirroring cannot be proven, production-number work stops and requires a separate migration decision.
- Secrets, customer data, raw chat exports, database dumps, recordings, and tunnel credentials must never enter Git, fixtures, logs, screenshots, or model prompts.
- Only `GET /webhooks/meta` and `POST /webhooks/meta` may be publicly routed. Admin, health, database, n8n, Manifest, OmniRoute, and all other application routes stay private.
- Webhook signatures are verified against the unmodified raw body before JSON parsing or storage. Untrusted payload content is never logged.
- PostgreSQL is authoritative for receipts, events, conversations, pauses, consent, retention, deletion, and outbound work.
- Models receive no tools. Approved FAQ and business facts take precedence over generation.
- Marketing requires explicit consent for the exact channel and category. Missing or blank consent always means ineligible and is not configurable.
- Casual chats are retained for 60 days from the latest qualifying human-authored event, unconverted leads for 12 calendar months from the latest qualifying lead interaction, and active-client support content throughout the documented relationship plus 24 calendar months after its documented end. Human replies pause AI for 24 hours unless an authorized reviewer resumes it earlier.
- Every behavior change follows test-first development. No external deployment or live-asset connection occurs merely because local tests pass.

## Delivery Method

Each task in `docs/TODO.md` records its dependencies, owner, approval boundary, and required evidence. A phase is complete only when:

1. every required task is complete;
2. the named automated and manual checks pass;
3. evidence is recorded without secrets or customer data;
4. no blocking decision remains open; and
5. the next phase does not cross an external-action boundary without approval.

Public DNS, Cloudflare tunnel creation, Meta asset mutation, server deployment, production permissions, live customer data, and production-number actions always require a separate operator approval immediately before the action.

## Phase 0: Preflight And Decision Closure

### Goal

Remove architectural ambiguity and define verifiable policies before application scaffolding.

### Work

- Record the plan audit and maintain the phase tracker.
- Select and pin the Node.js line, package manager, HTTP framework, PostgreSQL client/migration tool, validation library, test runner, linter, formatter, and container base images.
- Perform a read-only inventory of the dedicated Manifest Harness, Meta test app/number, Messenger test Page, current n8n dependency state, and available Cloudflare zone access. Record only presence, version, and readiness; never record identifiers or secrets.
- Define a channel behavior matrix. Messenger business replies use its echo events. WhatsApp manual-reply pausing remains a test-gated coexistence capability and must not be assumed from Messenger behavior.
- Define webhook admission precisely: maximum encoded body size, raw-body HMAC verification, constant-time comparison, schema parsing, per-channel normalization, event-time policy, durable receipt, duplicate outcome, acknowledgement outcome, and asynchronous processing.
- Define stable, channel-specific idempotency keys. Do not assume Meta supplies one universal delivery identifier.
- Define how stale, duplicated, malformed, unsupported, and out-of-order events are acknowledged and audited without causing repeated side effects or retry storms.
- Apply lifecycle precedence `active_client > unconverted_lead > casual_chat`. Record append-only reclassification events; AI replies, provider statuses, duplicates, retries, consent bookkeeping, and unresponded marketing sends never extend retention.
- Retain casual chats for 60 days from the latest qualifying customer or proven human-agent message, unconverted leads for 12 calendar months from the latest qualifying lead interaction, and active-client support content through the relationship plus 24 calendar months after its documented end or final paid service completion, whichever is later. The Fast Cyber Defense Managing Director/business-owner role owns the policy and reviews active-client classifications annually.
- Verify deletion through the same channel with an explicit phrase or known name plus authorized human review; never request a password, OTP, payment credential, or secret. Retain only the approved HMAC-keyed suppression or restore tombstone fields.
- Disable Manifest message-body recording before customer/model traffic. Restore backups only in isolation, reapply all unexpired deletion tombstones, and refuse promotion until post-restore deletion verification passes.
- Create a privacy-safe fixture policy and acceptance matrix covering security, replay, concurrency, bilingual quality, takeover, consent, retention, deletion, restore, and model/provider failure.
- Create a threat model for the public webhook boundary, outbound provider calls, internal networks, secrets, PostgreSQL, backups, and operational interfaces.

### Exit Gate

- All Phase 0 decisions in `docs/TODO.md` are closed or explicitly deferred to a later gate that does not affect Phase 1.
- The channel matrix, lifecycle rules, trust-boundary rules, test matrix, and technology choices are written and reviewed.
- No secret or live customer data was accessed or recorded.

Gate record: `docs/reviews/phase-0-gate.md`. Threat evidence:
`docs/security/threat-model.md`. Acceptance evidence:
`docs/testing/acceptance-matrix.md`. Validation record:
`docs/reviews/phase-0-gate-validation.md`.

## Phase 1: Local Scaffold And Webhook Security Core

### Goal

Build a strict, dependency-minimal TypeScript service whose public trust boundary is testable without external accounts.

### Work

- Scaffold strict TypeScript, reproducible package scripts, linting, formatting, type checking, unit tests, and secret-free CI.
- Validate configuration at startup and implement structured logging with field allowlists and redaction. Raw webhook bodies, authorization headers, tokens, customer message text, and model prompts must not be logged.
- Implement `GET /webhooks/meta` verification with exact mode, token, and challenge validation.
- Implement `POST /webhooks/meta` admission in this order: enforce body limit, preserve raw bytes, verify `X-Hub-Signature-256`, parse JSON, validate the envelope, normalize channel events, and submit them to an injected receipt sink.
- Use constant-time signature comparison and reject missing, malformed, wrong-length, or invalid signatures before parsing or persistence.
- Return `404` for every unapproved route and test both paths and HTTP methods.
- Implement separate WhatsApp and Messenger normalizers with sanitized fixtures. Unknown event shapes are safely acknowledged or rejected according to the Phase 0 matrix and never trigger a reply.

### Exit Gate

- Tests cover verification success/failure, Unicode raw bodies, altered bytes, malformed signatures, oversized bodies, malformed JSON, unsupported objects, route isolation, and both channel normalizers.
- Test, lint, format-check, and strict type-check commands pass locally and in secret-free CI.
- No network call, database write, or model call is required by the security-core tests.

## Phase 2: Durable Ingestion And Idempotency

### Goal

Make PostgreSQL-backed webhook receipt reliable across retries, restarts, concurrency, and partial failure.

### Work

- Add a local development/test PostgreSQL service and versioned migrations.
- Store minimal webhook receipts and normalized events rather than unrestricted raw payloads. Any temporary raw-body retention requires an explicit, time-bounded policy.
- Insert the receipt and event atomically with a unique, channel-specific idempotency key before acknowledging accepted work.
- Treat exact duplicates as successful no-ops. A duplicate must never create a second reply, escalation, consent change, or pause extension.
- Persist stale and unsupported outcomes according to the approved minimal audit policy, acknowledge them without side effects, and avoid retry storms.
- Separate fast webhook acknowledgement from asynchronous processing. Database unavailability must not produce a false success acknowledgement for work that was not durably accepted.
- Test concurrent duplicate delivery, process restart, transaction rollback, database outage, delayed events, and out-of-order status notifications.

### Exit Gate

- Replay and concurrency tests prove one durable logical event and no duplicate side effects.
- Restart and database-failure tests prove the documented acknowledgement behavior.
- Migrations apply to an empty database and upgrade the previous schema in tests.

## Phase 3: Conversation And Data-Policy Core

### Goal

Make every decision to respond, pause, retain, market, or delete deterministic and PostgreSQL-backed.

### Work

- Model contacts, channel identities, conversations, inbound events, human pauses, consent records, deletion requests, suppression records, and audit outcomes.
- Make inbound human/business echo events pause AI for 24 hours. Re-check the pause immediately before creating and immediately before sending an outbound reply to prevent races.
- Keep resume controls LAN-only and authenticated; do not expose them through the public tunnel.
- Record consent category, channel, exact wording/version, source, timestamp, and revocation. Missing or blank consent is always ineligible.
- Enforce 60-day casual-chat, 12-calendar-month unconverted-lead, and active-relationship-plus-24-calendar-month client retention from the qualifying anchors in `docs/architecture/data-lifecycle.md`. Automated, duplicate, retry, consent-only, and status activity never moves an anchor.
- Implement verified same-channel, human-reviewed deletion with idempotent live-data erasure, HMAC-keyed minimal suppression, Manifest-recording cleanup, and restore-safe tombstones. A password, OTP, payment credential, or secret is never a deletion verifier.
- Apply retention and deletion through repeatable jobs whose dry-run output contains counts only, never customer content.

### Exit Gate

- Tests cover echo-triggered takeover, pause races, expiry, authorized resume, consent grant/revoke/blank, retention boundaries, repeated deletion, suppression, and post-restore deletion enforcement.
- PostgreSQL remains the sole authority for all policy decisions.

## Phase 4: Approved Knowledge And Model Boundary

### Goal

Answer approved facts deterministically and use the dedicated Manifest Harness only when necessary.

### Work

- Store approved knowledge separately from fetched or proposed website content, including provenance, version, reviewer, approval status, and effective time.
- Keep crawling manual and disabled by default. Hash and diff each fetch; publication always requires review.
- Resolve approved FAQ and business facts before any model request.
- Redact credentials, OTPs, payment data, authentication material, and sensitive incident evidence before inference.
- Call only the dedicated `fcd-support` OpenAI-compatible endpoint with `model: "auto"`, no tools, bounded timeouts, output limits, and application-level per-contact limits.
- Treat Manifest request recordings as customer data, disable message-body recording before customer/model traffic, and keep the model path closed if recordings cannot be bounded and erased for verified deletion.
- On gateway, model, or provider failure, avoid fabricated answers; return the approved safe response and create an escalation outcome when policy requires it.
- Build a reviewed English/Bangla evaluation set for FAQ accuracy, language matching, refusal boundaries, incident escalation, and unsupported claims.

### Exit Gate

- Tests prove FAQ precedence, redaction, tool-free requests, rate limits, timeout handling, safe failure, and no fallback to OpenClaw, Hermes, or unrelated credentials.
- The bilingual evaluation reaches its Phase 0 approval threshold with reviewer evidence.

## Phase 5: Outbound Messaging And Channel Rules

### Goal

Send eligible responses without duplicate delivery or violations of channel policy.

### Work

- Implement a PostgreSQL outbox and worker with explicit states, leases, bounded retries, and terminal failure handling.
- Create separate WhatsApp and Messenger provider adapters behind one narrow interface.
- Pin the Meta Graph API version and record its support window before using it.
- Enforce the WhatsApp customer-service window and approved-template requirements before enqueue and before send.
- Apply per-contact, per-channel, and global rate limits; marketing additionally requires explicit consent for the exact category and channel.
- Re-check human pause, deletion, suppression, and consent immediately before send.
- Correlate provider message IDs with outbound intents and process sent, delivered, read, and failed statuses idempotently even when status order differs.

### Exit Gate

- Tests cover duplicate jobs, crashed workers, expired leases, provider timeouts, rate limits, pause races, opt-outs, service-window boundaries, and out-of-order statuses.
- Provider adapters pass contract tests against local HTTP fakes with no live tokens.

## Phase 6: Hardened Local Operations

### Goal

Produce a reproducible, private, recoverable Docker deployment without exposing external services.

### Work

- Pin production dependencies and container images, preferably by immutable digest where operationally supportable.
- Run application and database containers as non-root where compatible, with read-only filesystems, explicit writable mounts, health checks, resource limits, and no Docker socket or host filesystem access.
- Use separate least-privilege ingress, data, and model-network attachments. PostgreSQL has no published port; Manifest is reached through the verified Docker service/network name rather than a LAN address.
- Keep application health, metrics, migrations, and reviewer controls private.
- Validate forward migrations, backup-before-migration behavior, rollback procedures, and restoration into an isolated database.
- Create encrypted backups on the approved schedule without unbounded startup copies; retain 45 daily and 6 monthly archives. Perform and record quarterly restore tests.
- Reapply every unexpired deletion tombstone after an isolated restore and refuse to attach the restored database to the application until content-free deletion verification passes.
- Add privacy-safe health monitoring for the API, database, tunnel, and Manifest path. First-version incidents use the authenticated private dashboard and sanitized host journal independently of n8n; direct external notification adapters are deferred by owner.
- Keep n8n private and use authenticated, idempotent notification calls only. Do not disable its existing API until a dependency audit passes.

### Exit Gate

- Compose validation, container hardening checks, migrations, backup, restore, deletion-after-restore, and failure recovery tests pass locally.
- Network tests show only the intended container-to-container paths and no public host ports. The approved admin dashboard may bind only to host loopback for local or SSH-forwarded access.

Phase 6 written specification: `docs/superpowers/specs/2026-09-21-phase-6-hardened-local-operations-design.md` (owner approved 2026-10-04). Implementation plan: `docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md` (owner approved for sequential implementation 2026-10-18). P6 remains local implementation and validation before any separately approved server action.

## Phase 7: Approved Test-Asset Integration

### Goal

Validate the complete system with dedicated non-production Meta and Manifest assets.

### Approval Boundary

This phase requires explicit approval immediately before public DNS or tunnel changes, server deployment, or Meta asset connection. It may use only the Meta test number, test Page, dedicated Harness, synthetic contacts, and non-customer content.

### Work

- Verify the dedicated Harness from the application network without exposing its key or recordings.
- Configure a dedicated test tunnel hostname with only the two webhook paths and a final `http_status:404` catch-all. Validate and test every ingress rule.
- Connect only the Meta test number and Messenger test Page.
- Exercise verification, signature rejection, duplicate/retry, concurrency, stale downtime events, malformed payloads, manual takeover echoes, bilingual FAQ quality, incident escalation, consent/opt-out, deletion, restore, model fallback, provider outage, tunnel outage, and host restart.
- Record sanitized pass/fail evidence and unresolved platform limitations.

### Exit Gate

- Every test-number acceptance case passes or has an explicitly approved disposition.
- Manual reply visibility and echo behavior are documented separately for Messenger and WhatsApp.
- Production Meta assets remain unchanged.

## Phase 8: Production-Readiness Decision

### Goal

Make a documented go/no-go decision without changing the production WhatsApp number.

### Work

- Approve website and support wording for AI assistance, external inference, retention, deletion, consent, and human escalation.
- Confirm Meta permissions, token ownership/rotation, app review state, Graph API support window, and operational owners.
- Confirm production-number coexistence eligibility and the exact onboarding path through a non-mutating check.
- Confirm WhatsApp manual-app reply mirroring can provide the tested pause signal. If unavailable, stop and create a separate migration decision; do not alter the number.
- Confirm n8n dependency audit, alert ownership, on-call/manual coverage, backup ownership, and quarterly restore schedule.
- Review all tracker evidence and unresolved risks.

### Exit Gate

- A signed-off readiness record states either `GO TO SEPARATE PRODUCTION PLAN` or `NO-GO`.
- This gate never authorizes production onboarding by itself.

## Production Promotion

Production promotion is intentionally outside this plan. It requires a separate, reviewed runbook and explicit approval for the exact Meta, DNS, tunnel, server, secret, migration, rollback, and customer-communication actions. If coexistence is unavailable or any validation gate fails, the production number remains untouched.

## Primary Platform References

- [Meta Messenger Platform webhook collection](https://www.postman.com/meta/messenger-platform-api/folder/22794852-b5d97624-14d8-4e67-a2e4-529add49ca58): signature validation, acknowledgement behavior, and business message echoes.
- [Meta WhatsApp webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference): WhatsApp envelopes, message IDs, and status events.
- [Meta WhatsApp status notification reference](https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications): status timestamps and possible out-of-order delivery.
- [Cloudflare Tunnel ingress configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/): ordered path rules, required catch-all, validation, and rule testing.
- [Manifest repository](https://github.com/mnfst/manifest): OpenAI-compatible endpoint, `auto` routing, limits, fallbacks, and request tracking.
