# Project Context

Last reviewed: 2026-08-26 (Asia/Dhaka)

## Confirmed Decisions

- Build a dedicated customer-support application; OpenClaw and Hermes remain private/internal.
- Automate WhatsApp Business and Facebook Messenger. Instagram DM automation is not part of the first release.
- Use English and Bangla, approved FAQ answers first, and AI only when needed.
- Use Manifest Harness `fcd-support` with its dedicated API configuration, provider scope, default model, up to five fallbacks, limits, and observability.
- Use a Meta test number before any production WhatsApp change. The current production account stays linked to Meta.
- Staff retain Meta Business Suite access and manually cover periods when the local server is off.
- Human staff replies pause AI for that conversation for 24 hours unless resumed earlier.
- Crawl `https://fastcyberdefense.com/` only on demand; all changes require review before publication to the knowledge base.
- Casual chats: 60-day retention. Unconverted leads: 12 months. Active-client data: relationship and required retention period.
- Marketing requires explicit, category-specific opt-in. Blank means no promotional eligibility.

## Existing Local Infrastructure

- Server: Ubuntu at `192.168.10.40`; normally online about 12 hours per day.
- Capacity observed during planning: 4 CPU cores, about 15 GiB RAM with about 13 GiB available, and about 69 GiB free disk. No GPU is present or required.
- Docker and Docker Compose are already in use.
- Manifest: local OpenAI-compatible gateway on port `2099`; Docker networks include `mnfst_frontend` and `mnfst_internal`.
- OmniRoute: local gateway on port `20128`; use only if required by the approved Manifest fallback policy.
- n8n `2.33.6`: LAN-bound on port `5678`, with external runners. Its public API was enabled during the audit and must be checked for dependencies before disabling.
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

## Launch Blockers

- The admission-only test deployment is approved and running under a narrow exception. Outbound messaging, models, n8n actions, live customer data, and production deployment remain unauthorized.
- Phase 0 policy and external-readiness decisions remain open. The project owner authorized reversible local development through Phase 5; exceptions and provisional contracts are tracked in `docs/TODO.md`.
- Meta test callback and subscription flows are validated only for development-mode test assets. App review, live permissions, and production assets remain unvalidated.
- WhatsApp coexistence for the production number has not been confirmed.
- The dedicated Manifest Harness/API routing has not been tested from the application network.
- Website privacy and support wording must disclose AI assistance, external inference, retention, deletion, and marketing consent before production launch.
- Backup restore and human-takeover behavior must pass acceptance tests.

## First Session Checklist

1. Read `docs/PLAN.md`, `AGENTS.md`, and this file.
2. Inspect Git status and preserve unrelated changes.
3. Read `docs/TODO.md` and select the first unblocked task whose dependencies are complete.
4. Confirm the current Manifest Harness configuration and Meta test assets only when the tracker calls for a read-only inventory, without exposing secrets or modifying production assets.
5. Keep unresolved Phase 0 policy-dependent behavior provisional and do not advance to Phase 2 until the formal gates in `docs/TODO.md` pass.
6. Deploy to the test-number environment only after all local phase gates pass and the exact external actions receive approval.
