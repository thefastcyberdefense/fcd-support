# Project Context

Last reviewed: 2026-08-11 (Asia/Dhaka)

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
- `fastcyberdefense.com` already uses Cloudflare nameservers. `cloudflared` was not installed on the server at the time of the audit.

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

## Launch Blockers

- Local Phase 1 and Phase 2 code exists, including PostgreSQL-backed durable receipt, but no application deployment has been approved.
- Phase 0 policy and external-readiness decisions remain open. The project owner authorized reversible local development through Phase 5; exceptions and provisional contracts are tracked in `docs/TODO.md`.
- Meta test-number and Messenger permission flows have not been validated.
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
