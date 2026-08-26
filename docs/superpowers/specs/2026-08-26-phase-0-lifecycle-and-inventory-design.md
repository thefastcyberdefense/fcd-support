# Phase 0 Lifecycle and Preflight Inventory Design

**Date:** 2026-08-26  
**Status:** Approved for implementation  
**Scope:** P0-009 through P0-016  
**Policy owner:** Fast Cyber Defense Managing Director/business-owner role

## Objective

Close the remaining Phase 0 lifecycle and read-only inventory decisions without
changing production Meta assets, public DNS, live customer data, or irreversible
server state. This specification defines the authoritative retention, deletion,
suppression, backup-restore, and provider-inventory contract that later database
and runtime work must implement.

Completion of these Phase 0 rows records decisions and sanitized evidence. It
does not by itself authorize production launch or imply that the later runtime
controls have already been implemented.

## Governing principles

- PostgreSQL remains the authoritative conversation, consent, lifecycle, and
  deletion state store.
- Store only data required for a documented support purpose and only for the
  approved period.
- Use UTC for stored timestamps and retention calculations. Operator-facing
  displays may use `Asia/Dhaka` (`UTC+06:00`).
- A verified deletion overrides lifecycle classification and retention periods,
  except for a content-free deletion tombstone and records that must be retained
  under a separately documented legal obligation.
- Accounting, contractual, security, or regulatory records that require a
  different retention period must be stored separately from support conversation
  content and governed by their own schedule.
- AI-generated messages, delivery receipts, duplicate deliveries, retries, and
  system events must never extend customer-content retention.
- This is an engineering and business policy, not legal advice. The policy owner
  is responsible for obtaining legal review before production launch if needed.

## Lifecycle classification and anchors

Lifecycle precedence is:

`active_client > unconverted_lead > casual_chat`

Only one effective lifecycle class applies at a time. Every classification or
reclassification must be stored as an append-only audit event containing the old
class, new class, reason code, actor type, and effective timestamp. The runtime
may materialize the current class for efficient queries, but the audit history is
authoritative for explaining transitions.

### Casual chat

- Retention period: 60 days.
- Anchor: the most recent qualifying human-authored conversation event.
- Qualifying events: an inbound customer message or a proven human-agent reply.
- Excluded events: AI replies, templates sent without a customer response,
  delivery/read receipts, message reactions without business meaning, duplicate
  events, retries, administrative changes, and retention-job activity.
- Expiry: the record becomes eligible at `anchor + 60 * 24 hours`, evaluated in
  UTC with `now >= expires_at`.

### Unconverted lead

- Retention period: 12 calendar months.
- Anchor: the most recent qualifying lead interaction while the person remains an
  unconverted lead.
- Qualifying events: a customer message or proven human-agent interaction tied to
  a documented sales, quotation, consultation, or follow-up purpose.
- Excluded events: AI-only activity, status callbacks, delivery/read receipts,
  marketing sends without a response, consent bookkeeping, duplicates, retries,
  and retention-job activity.
- Expiry: the same calendar day 12 months after the anchor. If the target month
  lacks that day, use the final day of the target month. Evaluate in UTC.

### Active client

- Retention period: throughout the documented active service relationship and
  for 24 calendar months after the documented relationship end or final paid
  service completion, whichever is later.
- Anchor while active: the documented relationship-start event establishes the
  class; no automatic deletion occurs while a current relationship is confirmed.
- Post-relationship anchor: the later of the documented relationship-end time or
  final paid service-completion time.
- Expiry: 24 calendar months after the post-relationship anchor, using the same
  end-of-month rule as unconverted leads.
- Review: the policy owner must review active-client classification at least
  annually so an abandoned `active_client` flag cannot create indefinite
  retention.

### Reclassification

- Promotion from casual chat to unconverted lead recalculates expiry from the
  latest qualifying lead interaction, not from an AI or system event.
- Conversion to active client suspends automatic content expiry while the
  relationship is documented as active.
- Relationship closure starts the 24-month post-relationship period.
- Downgrading a class must not resurrect content already deleted or create a new
  anchor from non-qualifying activity.
- Marketing consent is independent of lifecycle classification and never extends
  conversation retention.

## Deletion verification and execution

Deletion uses a same-channel, human-reviewed flow:

1. The customer requests deletion through the same WhatsApp or Messenger identity
   associated with the data.
2. The service asks for an explicit confirmation phrase or the name already
   associated with the conversation. It must never ask for a password, OTP,
   payment credential, or other secret.
3. An authorized human reviewer confirms that the channel identity and request
   context are consistent. Ambiguous or disputed requests are paused for manual
   resolution.
4. The deletion command is idempotent and records a request identifier, reviewer,
   decision timestamp, execution status, and content-free result counts.
5. The service deletes applicable live conversation content, customer profile
   data, derived summaries, embeddings, model artifacts, and provider recordings
   that can be associated with the verified identity.
6. The service creates or refreshes the minimal deletion tombstone described
   below so deleted data cannot be reintroduced from backups.

Deletion does not authorize removal of a separately governed record subject to a
documented legal obligation. Such an exception requires a reason code, policy
owner approval, access restriction, and an explicit expiry or review date.

## Minimal suppression and deletion tombstones

The suppression store contains no raw external identity and no message content.
Its identity key is an HMAC over a canonical channel name and canonical external
identity, using a dedicated versioned key that is not reused for encryption or
webhook verification.

Required fields are limited to:

- `identity_hmac`
- `channel`
- `category` (`marketing_opt_out` or `deletion_tombstone`)
- `reason_code`
- `effective_at`
- `key_version`
- `expires_at` when the category has a defined expiry

Marketing opt-out suppression remains effective until a later verified opt-in.
A blank consent value is always treated as no promotional eligibility.

A deletion tombstone remains until 30 days after the newest backup that could
contain the deleted identity has expired. Key rotation must support matching all
unexpired tombstones without retaining the raw identifier.

## Manifest recording policy

- The dedicated Manifest harness is `fcd-support`, category `app`, platform
  `openai-sdk`, requesting model `auto`.
- Message-body recording must be disabled before any customer or model traffic is
  allowed through the harness.
- The current preflight inventory found recording enabled but found no request
  rows for this harness, so no known customer recording currently requires
  deletion.
- If recording cannot be disabled, bounded, and erased for a verified deletion,
  the model path is a production no-go.
- Models receive no tools. The harness must not expose OpenClaw or Hermes to the
  public customer-support execution path.

## Backup restore and deletion reapplication

- Backups remain immutable and are not rewritten in place after each deletion.
- Every restore occurs in an isolated environment that cannot serve application
  traffic.
- Before promotion, the restore process loads all unexpired deletion tombstones,
  reapplies deletions idempotently, verifies that affected live and derived
  records are absent, and records content-free counts and completion status.
- A restored database must not be attached to the application until this gate
  passes.
- Backup-restore tests must cover tombstone key versions, repeated application,
  partial failure, retry, and evidence that deleted content is not served.

## Sanitized preflight inventories

The following evidence was collected read-only on 2026-08-26. No secret values,
account identifiers, customer content, workflow bodies, or raw provider payloads
may be added to repository documentation.

### Manifest (`P0-013`)

- Private service version: `6.11.0`.
- Dedicated active harness: `fcd-support`.
- Harness type: category `app`, platform `openai-sdk`.
- Private host connectivity and the requested `auto` model were verified.
- One active, unexpired harness key exists; its value is not recorded.
- Eighteen active provider connections are available to the harness: six named
  and twelve custom connections; seventeen use API keys and one uses a
  subscription mechanism.
- Complexity routing is disabled. No explicit fallback routes, tenant overrides,
  notification rules, or limit rules were found.
- Message-body recording is enabled and must be disabled before model traffic.
- No request rows were found for the harness at inventory time.
- The deployed admission API is not currently attached to Manifest's private
  Docker network. A future deployment task must add only the required private
  connectivity and use the internal service alias.
- Inventory result: completed, but not production-ready.

### Meta (`P0-014`)

- The business is verified and the development app has a Meta-provided WhatsApp
  test number plus a dedicated Messenger test Page.
- The production WhatsApp number and production Facebook Page remain untouched.
- Webhook verification and signed synthetic webhook samples succeeded for
  WhatsApp `messages`, including incoming, sent, delivered, read, contact, and
  supported identity-shape samples.
- Messenger testing is role-scoped while the app remains in development mode.
  Advanced live `pages_messaging` access is not approved.
- The configured Page token is valid for Page use but has a finite data-access
  expiry; the exact token and timestamps are not recorded here.
- The WhatsApp test access token was expired at inventory time and must be
  replaced before another real-device test.
- Runtime configuration pins Graph API `v25.0`; Meta webhook test samples used
  `v26.0`. Phase 5 must choose, test, and document one supported production
  version before launch.
- Inventory result: completed, but test/live readiness remains gated.

### n8n (`P0-015`)

- Private/LAN-only service version: `2.35.3`.
- Four workflows exist; two are active and two contain HTTP Request nodes.
- No workflow or scanned server configuration contained a static dependency on
  n8n's public `/api/v1` interface.
- Three n8n API keys exist and two show historical use. Key values, workflow
  names, workflow bodies, and request data were not exported.
- Disposition: `fcd-support` has zero discovered n8n public-API dependencies.
  Keep the public API LAN-only and enabled until the owners of historically used
  keys are identified; later revoke unused keys or disable the API through a
  separately approved change.
- n8n may notify or trigger later CRM actions but must not own conversation,
  consent, lifecycle, or deletion state.
- Inventory result: completed; no configuration mutation performed.

### Cloudflare (`P0-016`)

- Zone access and the dedicated tunnel were previously verified.
- Only the exact signed Meta webhook verification/event path is routed publicly.
- Admin, health, database, n8n, Manifest, OmniRoute, and non-webhook API paths
  remain private; unmatched ingress returns a denial response.
- Inventory result: already completed; no route or DNS mutation is part of this
  bundle.

## Tracker closure mapping

- `P0-009`: complete when the lifecycle anchors, precedence, expiry calculations,
  and reclassification semantics above are recorded in the canonical plan and
  tracker.
- `P0-010`: complete when the active-client period, justification, annual review,
  and accountable policy-owner role are recorded.
- `P0-011`: complete when same-channel confirmation, human review, idempotency,
  suppression schema, and prohibitions on secret-based verification are recorded.
- `P0-012`: complete when Manifest recording and backup-restore deletion behavior
  are recorded, including the production no-go condition.
- `P0-013`: complete as a sanitized read-only Manifest inventory; its readiness
  findings remain future implementation gates.
- `P0-014`: complete as a sanitized Meta inventory; expired/test/live permission
  findings remain future test and launch gates.
- `P0-015`: complete as a sanitized n8n dependency audit with a documented
  keep-enabled/LAN-only disposition.
- `P0-016`: remains complete based on previously verified Cloudflare access and
  route isolation.

## Follow-on work and non-goals

This design does not implement database migrations, retention jobs, deletion
workers, Manifest setting changes, Docker network changes, Meta permission
requests, token rotation, n8n key revocation, Cloudflare route changes, or
production deployment. Those actions remain in their later approved phases and
must satisfy the repository validation gates.

The immediate implementation following this specification is documentation and
tracker synchronization only. It must leave the Ubuntu deployment pinned at its
current admission-only commit until a separately approved deployment task.

## Acceptance criteria

- The canonical plan, tracker, and project context agree with this specification.
- P0-009 through P0-016 have evidence-backed statuses and readiness findings.
- No secret values, account identifiers, customer content, raw webhook payloads,
  workflow bodies, database dumps, or provider connection identifiers are added.
- The production WhatsApp number, production Facebook Page, Meta permissions,
  public DNS, Cloudflare routes, and server runtime remain unchanged.
- Documentation checks and the repository's full local validation gate pass
  before the implementation commit is pushed.

## References

- Bangladesh National Data Governance Ordinance, 2025:
  <https://bdlaws.minlaw.gov.bd/act-print-1573.html>
- National Board of Revenue, Income Tax Acts:
  <https://nbr.gov.bd/regulations/acts/income-tax-acts/eng>
- Existing repository plan and approved Phase 0 preflight specification.
