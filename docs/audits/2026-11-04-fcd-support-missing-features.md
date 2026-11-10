# Fast Cyber Defense Support (`fcd-support`) - Missing Features & Product Proposals Roadmap

- **Current Scope Status:** **Unapproved Product & Operator Enhancement Proposals (Not Approved Blockers or Current Implementation Scope)**
- **Approval Boundary:** Per `AGENTS.md`, `docs/PLAN.md`, and `docs/reviews/2026-11-07-agy-update-disposition.md`, `fcd-support` is currently designed with a webhook-only public ingress (`GET /webhooks/meta` and `POST /webhooks/meta` in `src/app.ts`), a private admin console (`src/admin/`), PostgreSQL authoritative state, n8n workflow notifications, and bounded tool-free Manifest `fcd-support` (`model: "auto"`) fallback. None of the items below may be implemented without separate owner/architecture approval.

## Proposed P0 Product & Operator Enhancements (Requires Separate Approval)

1. **Public Support & Trust Center (Proposed — Conflicts with Current Webhook-Only Exposure Unless Separately Approved):** Bilingual published FAQ, support/contact intake, approved-content projection, secure headers, and abuse controls on a dedicated public renderer (`support.fastcyberdefense.com`), kept strictly separate from the webhook and private admin origins.
2. **Public status page (Proposed):** Curated customer-safe service state, incident updates, and stale-safe fallback with zero internal IDs or raw health evidence.
3. **Privacy/data-rights self-service portal (Proposed Enhancement):** Web-based channel-verified request status on top of the existing PostgreSQL deletion, access-export (`src/persistence/postgres-access-export.ts`), and correction (`src/persistence/postgres-correction.ts`) backend workflows.
4. **Verified WhatsApp/Messenger entry pages (Proposed):** Canonical official links, emergency warnings, and fallback instructions when messaging apps are unavailable.
5. **Media/attachment ingestion (Proposed Enhancement):** Image/PDF/audio metadata quarantine, MIME/signature checks, malware scanning, encrypted references, and retention hooks (current webhook admission is text-focused by design).
6. **Cybersecurity incident triage & SLA timers (Proposed Enhancement):** Deterministic severity rubric, incident owner assignment, and leased SLA breach reminder scheduling on top of existing escalation records.
7. **Direct emergency notification failover (Owner-Deferred in Phase 6):** Independently configured Telegram/email/SMS/HMAC failover adapters alongside n8n. **Note:** Direct external notification adapters were explicitly deferred by the project owner in Phase 6; n8n remains the approved notification path.
8. **Operator inbox and human takeover reply composer UI (Proposed Enhancement):** Web UI composer layered over the existing backend human-takeover state, sensitive-data gate (`src/safety/sensitive-data-gate.ts`), and outbound work store (`src/persistence/postgres-outbound-work-store.ts`).
9. **Admin account lifecycle UI (Proposed Enhancement):** Self-service UI for creating/revoking operator accounts, rotating passwords, resetting MFA, and revoking sessions (currently managed via CLI/store modules in `src/admin/`).
10. **Public abuse and trust-boundary hardening for future web surfaces (Proposed):** Route-level rate limits, bot defense, and public/private origin separation if a public web surface is ever approved.

## Proposed P1 High-Value Capabilities (Future Roadmap Proposals)

- WhatsApp/Messenger interactive triage buttons and quick replies.
- Secure attachment review/OCR/transcription after quarantine.
- WhatsApp template variables, provider sync, and approval/rejection lifecycle UI.
- Typing/read/presence indicators and richer status normalization.
- Expanded EN/BN localization catalog and language detection refinements.
- Search, filtering, cursor pagination, and safe CSV/JSON exports across admin modules.
- Knowledge crawl/source snapshot diff viewer with exact approval binding.
- Private admin SSE with durable cursor and polling fallback.
- Per-conversation model latency/token/cost telemetry and budget enforcement.

## Proposed P2 Post-Launch Growth (Future Roadmap Proposals)

- Hybrid PostgreSQL FTS/trigram retrieval, then `pgvector` only if measured need exists.
- Lead pipeline and CRM synchronization through an idempotent privacy-aware outbox.
- Additional reviewed locales and translation-memory workflow.
- Verified customer case history portal and one-time secure access export downloads.

## Unverified Local Roadmap Story Labels (`US-101`..`US-105`) & ClickUp Boundary

- `US-101` (Proposed): Admin account/role/password/MFA/session lifecycle UI.
- `US-102` (Proposed): Operator inbox and human takeover reply composer UI.
- `US-103` (Owner-Deferred in Phase 6): Direct emergency notification failover adapter.
- `US-104` (Proposed): Incident triage and SLA scheduler.
- `US-105` (Proposed — Requires Public-Exposure Boundary Change Decision): Public bilingual Support & Trust Center, status, privacy, and verified channel pages.

> **ClickUp & Approval Provenance Notice:** `US-101` through `US-105` are local roadmap proposal identifiers authored in this audit series. **Remote ClickUp evidence is unavailable**: no FCD Support ClickUp task/document IDs or URLs were inspected or verified, and independent read-only searches across connected ClickUp workspaces (`docs/reviews/2026-11-07-agy-update-disposition.md`) found no FCD Support story records. Do not treat `US-101`..`US-105` as approved stories or active implementation assignments.
