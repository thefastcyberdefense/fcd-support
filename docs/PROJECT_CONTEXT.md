# Project Context

Last reviewed: 2026-09-01 (Asia/Dhaka)

## Confirmed Decisions

- Build a dedicated customer-support application; OpenClaw and Hermes remain private/internal.
- Automate WhatsApp Business and Facebook Messenger. Instagram DM automation is not part of the first release.
- Use English and Bangla, approved FAQ answers first, and AI only when needed.
- Use Manifest Harness `fcd-support` with its dedicated API configuration, provider scope, default model, up to five fallbacks, limits, and observability.
- Use a Meta test number before any production WhatsApp change. The current production account stays linked to Meta.
- Staff retain Meta Business Suite access and manually cover periods when the local server is off.
- Human staff replies pause AI for that conversation for 24 hours unless resumed earlier.
- Crawl `https://fastcyberdefense.com/` only on demand; all changes require review before publication to the knowledge base.
- Lifecycle precedence is `active_client > unconverted_lead > casual_chat`. Casual chats expire 60 days after the latest qualifying human-authored event; unconverted leads expire 12 calendar months after the latest qualifying lead interaction. AI replies, statuses, duplicates, retries, consent bookkeeping, and unresponded marketing sends never extend retention.
- Active-client support content is retained during the documented relationship and for 24 calendar months after the later documented relationship end or final paid service completion. The Fast Cyber Defense Managing Director/business-owner role owns the policy and reviews active-client classifications annually.
- Deletion uses same-channel explicit confirmation plus human review, never a password, OTP, payment credential, or secret. Minimal suppression and restore tombstones use a versioned HMAC identity and no raw identifier or message content.
- `REQUEST MY DATA`, `CORRECT MY DATA`, and all-linked-identity `STOP MARKETING` use deterministic P3-007 intake plus human review. Access collection is private, redacting, one-run, and review-expiring; correction has no production handler until a field owner is approved; marketing opt-out covers all four closed categories and re-opt-in changes only named categories at its effective time.
- Manifest message-body recording must be disabled before customer/model traffic; restored backups remain isolated until all unexpired deletion tombstones are reapplied and verified.
- Marketing requires explicit, category-specific opt-in. Blank means no promotional eligibility.

## Existing Local Infrastructure

- Server: Ubuntu at `192.168.10.40`; normally online about 12 hours per day.
- Capacity observed during planning: 4 CPU cores, about 15 GiB RAM with about 13 GiB available, and about 69 GiB free disk. No GPU is present or required.
- Docker and Docker Compose are already in use.
- Manifest `6.11.0`: local OpenAI-compatible gateway on port `2099`; Docker networks include `mnfst_frontend` and `mnfst_internal`. The `fcd-support`/`auto` host check passes, but recording is enabled, explicit fallback/limit rules were not found, and the admission API lacks private Manifest-network attachment.
- OmniRoute: local gateway on port `20128`; use only if required by the approved Manifest fallback policy.
- n8n `2.35.3`: LAN-bound on port `5678`, with external runners. The audit found zero static `fcd-support` public-API dependencies, but two API keys have historical use; keep the API enabled and LAN-only until their owners are identified.
- OpenClaw and Hermes are already configured but are explicitly outside this application's public execution path.
- UFW and Docker ingress rules are intended to allow LAN access only. Do not add a public router port forward.
- `fastcyberdefense.com` uses Cloudflare nameservers. A dedicated project tunnel container now exposes only the exact Meta webhook path to the internal admission-only API; health, database, n8n, Manifest, OmniRoute, and other paths remain private.

## Planned Deployment

- Local repository: `J:\DevDrive\fcd-support`
- Remote repository: `https://github.com/thefastcyberdefense/fcd-support`
- Proposed server directory: `/home/redwan/apps/fcd-support`
- Public hostname: a dedicated subdomain of `fastcyberdefense.com`, exposing only Meta webhook verification and delivery paths.
- Windows is the only source-authoring, commit, and push host. During an approved test-deployment gate, Ubuntu pulls the exact committed revision from GitHub; do not copy or edit application source directly on the server.

## External Prerequisites

- Cloudflare account access for the Fast Cyber Defense zone and a dedicated tunnel token.
- Meta developer app, Page permissions, WhatsApp test number, webhook verification token, app secret, and channel access tokens.
- Manifest Harness `fcd-support` plus its dedicated endpoint/key and approved routing configuration.
- Telegram destination and authenticated private n8n webhook for escalations.

All secret values are intentionally absent from this repository. Create them during implementation and store them only in protected runtime secret files.

## Test-Asset Status

- The Meta development app, WhatsApp test number, and Messenger test Page are connected to the verified callback; production assets remain untouched.
- Messenger role-scoped customer delivery, a manual Page-reply echo, and WhatsApp v26.0 synthetic incoming/status delivery have reached durable ingestion. The admission-only runtime does not yet apply the echo to policy state.
- The app remains unpublished. A real device-originated WhatsApp message sent during the 2026-08-26 post-redeployment check did not reach the callback, so real delivery and production permissions remain unproven.
- The deployed admission-only normalizer accepts phone-unavailable v26 text messages through a namespaced user identity and deliberately leaves contact-card content unsupported. A signed public-callback smoke test and exact retry passed at revision `207a5e6357c1e1a7c75918793262d835574d898d`.

## Current Local Policy Evidence

- P3-005 retention, P3-006 verified deletion, and P3-007 privacy rights are locally complete. The current gate passes 213 local tests and 244 guarded synthetic PostgreSQL tests across 16 files, with zero leaked temporary schemas or advisory locks.
- P3-006 verifies same-channel requests through authorized human review, atomically tombstones and pseudonymizes linked identities, clears implemented raw event/customer content, retains aggregate evidence, and blocks later raw storage for deleted identities.
- The restore primitive reapplies all covered active tombstone key versions in bounded batches and refuses a pass on missing keys, failed/nonzero evidence, remaining matches, changed revision material, or an incomplete concurrent scan.
- P3-007 exact intake, reviewer holds, redacting one-run access collection, typed correction boundaries, category-scoped opt-out/re-opt-in, and evidence-preserving rollback pass locally. Security scan `1f4a68bb-5290-480f-89f4-6297d840ec87` reviewed 15 production surfaces; its five medium findings in the original range all have guarded remediation tests.
- No Meta/Manifest/provider deletion, access delivery, export/offline/archive cleanup, notification delivery, actual backup creation/restore/promotion, Ubuntu redeployment, or production action occurred. Those locations remain pending or belong to P6-004 and later test gates.

## Launch Blockers

- The admission-only test deployment is approved and running under a narrow exception. Outbound messaging, models, n8n actions, live customer data, and production deployment remain unauthorized.
- Phase 0 is evidence-complete: the threat model, acceptance matrix, and planning-only gate review are recorded in `docs/security/threat-model.md`, `docs/testing/acceptance-matrix.md`, and `docs/reviews/phase-0-gate.md`. This closes architectural planning only; every `PARTIAL`, `PLANNED`, or `BLOCKED` acceptance row remains a launch blocker. The project owner authorized reversible local development through Phase 5; exceptions and current contracts are tracked in `docs/TODO.md`.
- Meta test callback and subscription flows are validated only for development-mode test assets. App review, live permissions, and production assets remain unvalidated.
- WhatsApp coexistence for the production number has not been confirmed.
- The dedicated Manifest host harness/key and `auto` model are verified privately, but the application-network route, recording-off state, and explicit provider fallback/limit behavior remain untested.
- The WhatsApp test token was expired at inventory time; the app remains development/role-scoped, and runtime Graph `v25.0` versus webhook-sample `v26.0` requires an approved version/support decision.
- n8n's audit found no `fcd-support` public-API dependency, but owners of historically used API keys must be identified before revocation or disablement.
- Website privacy and support wording must disclose AI assistance, external inference, retention, deletion, and marketing consent before production launch.
- Actual encrypted backup/restore procedures and deployed human-takeover behavior must still pass their acceptance tests; the local restore-gate primitive alone does not satisfy P6-004.

The next unblocked tracker action is P3-GATE, which requires explicit
project-owner review of the complete Phase 3 evidence. Phase 4 planning remains
blocked until that review is recorded. P1-GATE remains a separate explicit
review record.

## First Session Checklist

1. Read `docs/PLAN.md`, `AGENTS.md`, and this file.
2. Inspect Git status and preserve unrelated changes.
3. Read `docs/TODO.md` and select the first unblocked task whose dependencies are complete.
4. Use `docs/operations/preflight-inventory.md` for current Manifest, Meta, n8n, and Cloudflare readiness; repeat external inspection only when the tracker requires it, without exposing secrets or modifying production assets.
5. Implement lifecycle behavior only from `docs/architecture/data-lifecycle.md` and do not treat evidence-complete inventories as implementation or production readiness.
6. Deploy to the test-number environment only after all local phase gates pass and the exact external actions receive approval.
