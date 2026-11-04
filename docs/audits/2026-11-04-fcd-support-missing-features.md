# Fast Cyber Defense Support (`fcd-support`) - Missing Features Roadmap

**Current product verdict:** Strong backend foundation, incomplete customer-support product.

## P0: Must-have before production

1. **Public Support & Trust Center:** bilingual published FAQ, support/contact intake, approved-content projection, secure headers and abuse controls.
2. **Public status page:** curated customer-safe service state, incident updates, stale-safe fallback, no internal IDs or raw health evidence.
3. **Privacy/data-rights portal:** one-time channel-verified request status, anti-enumeration, deletion/access/correction workflows, expiring status tokens.
4. **Verified WhatsApp/Messenger entry pages:** canonical official links, emergency warnings, campaign attribution, fallback when apps are unavailable.
5. **Media/attachment ingestion:** image/PDF/audio metadata, quarantine, MIME/signature checks, malware scan, encrypted references, deletion and retention hooks.
6. **Cybersecurity incident triage:** deterministic severity rubric, safe questions, incident owner, acknowledgement, response deadlines, no secrets or raw forensic dumps.
7. **Direct emergency notification failover:** n8n plus independently configured Telegram/email/SMS/HMAC webhook route with idempotent, bounded delivery.
8. **SLA timers and breach reminders:** append-only deadlines, leased scheduler, reminders, escalation policy, operator ownership.
9. **Operator inbox and human takeover reply composer:** redacted conversation view, role-gated reply, sensitive-data gate, outbound policy rechecks, delivery state.
10. **Admin account lifecycle UI:** create/revoke accounts, roles, password rotation, MFA reset, active-session revocation, step-up MFA, audit evidence.
11. **Public abuse and trust-boundary hardening:** route-level limits, CSRF/CORS/host validation, request IDs, bot defense, public/private origin separation.

## P1: High-value launch capabilities

- WhatsApp/Messenger interactive triage buttons and quick replies.
- Secure attachment review/OCR/transcription after quarantine.
- WhatsApp template variables, provider sync, approval/rejection lifecycle.
- Typing/read/presence indicators and richer status normalization.
- Reliable EN/BN language detection and reviewed localization catalog.
- Search, filtering, cursor pagination and safe CSV/JSON exports across admin modules.
- Knowledge crawl/source snapshot diff viewer with exact approval binding.
- Private admin SSE with durable cursor and polling fallback.
- Executable evaluation harness as a CI gate using versioned synthetic corpora.
- Per-conversation model latency/token/cost telemetry and budget enforcement.

## P2: Post-launch growth

- Hybrid PostgreSQL FTS/trigram retrieval, then pgvector only if measured need exists.
- Lead pipeline and CRM synchronization through an idempotent privacy-aware outbox.
- Additional reviewed locales and translation-memory workflow.
- Verified customer case history, preferences, and one-time secure access exports.

## Dependency-ordered Ralph stories

- `US-101`: admin account/role/password/MFA/session UI.
- `US-102`: operator inbox and human takeover reply.
- `US-103`: direct emergency notification failover.
- `US-104`: incident triage and SLA scheduler.
- `US-105`: public bilingual Support & Trust Center, status, privacy and verified channel pages.

Each story requires source implementation, tests, security review, UI evidence where relevant, and separate deployment/release approval.
