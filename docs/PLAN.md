# Fast Cyber Defense Support: Final Refined Plan

## Summary
- Use a dedicated Manifest Harness named `fcd-support` for this application. The Harness provides its own routing policy, provider selection, limits, usage tracking, and dedicated API configuration.
- Select **App AI SDK → Other** for the custom support service. The service calls the Harness-specific OpenAI-compatible endpoint/key, never the existing OpenClaw or Hermes API credentials.
- Keep the existing WhatsApp Business account linked to Meta. Build and validate with a Meta test number first; production number onboarding occurs only after a successful test gate.

## Model And Routing Policy
- Configure the `fcd-support` Harness:
  - **Default:** the best currently evaluated customer-support model.
  - **Fallbacks:** up to five approved models, ordered by bilingual quality, reliability, privacy suitability, and latency.
  - **Providers:** attach only approved StepFun, DeepSeek, OpenRouter, and other subscriptions needed for support; do not inherit unrelated providers by default.
  - **Limits:** enable Harness usage/cost limits and alerts; set application-level per-contact request/token/rate limits.
- The service requests the Harness `auto` model, so Manifest routes inside the dedicated FCD model/fallback policy. Review benchmark results before changing its default/fallback order.
- Keep all model calls tool-free. Use approved FAQ answers first, then model calls only for unresolved customer questions. Redact credentials, payment data, OTPs, and sensitive incident evidence before inference.
- Treat Harness request recordings as customer data: restrict access, apply the 60-day casual-chat retention, and redact or disable raw-body recording where required. Manifest supports per-agent/app routing, limits, fallbacks, and request tracking. [Manifest](https://github.com/mnfst/manifest)

## Local Support Stack
- Deploy a dedicated, pinned-image Docker Compose project:
  - `fcd-support-api`: TypeScript webhook and conversation service.
  - `fcd-support-postgres`: local source of truth.
  - `cloudflared`: outbound-only Meta webhook ingress.
- Isolate containers on an FCD internal network. Give only the API service access to the FCD Manifest endpoint; no Docker socket, host filesystem, shell tools, or public admin service.
- Publish one hostname and two paths only: `GET /webhooks/meta` for verification and `POST /webhooks/meta` for WhatsApp/Messenger. Verify HMAC signatures, deduplicate events, enforce payload limits, and return `404` for every other public route.
- Use Cloudflare Tunnel instead of firewall/router changes. Do not expose n8n, PostgreSQL, Manifest, OmniRoute, or an admin interface publicly. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- Connect to Manifest through Docker networking, not the server’s LAN IP. Keep OmniRoute as a tested fallback only if the Harness fallback policy requires it.
- Run the stack with `restart: unless-stopped`; when the PC is off, no bot reply occurs and staff continue manual support in Meta Business Suite.

## Customer, Knowledge, And Data Rules
- Introduce the bot as Fast Cyber Defense’s virtual assistant; reply in English or Bangla.
- Human staff replies from Meta Business Suite trigger `human_paused` for that conversation. AI remains silent for 24 hours or until a LAN-only reviewer resumes it. Discard old/retried webhook events after downtime.
- Escalate potential incidents and emergency requests to the team; direct customers to WhatsApp/Messenger calling. Do not solicit forensic files, access credentials, or detailed attack material in chat.
- Crawl the public website only on demand. Hash/diff every fetch, send changes to a local review queue, and publish only approved FAQs, services, contacts, prices, and policies. Keep approved business facts separately so the bot never repeats unverified site claims.
- Retain casual chats for 60 days, unconverted leads for 12 months, and active-client records for the relationship/required retention. Support verified deletion requests and keep only a minimal suppression record for opt-outs.
- Require explicit marketing opt-in per channel/category; blank means no promotions. Record consent wording, timestamp, source, and channel. Respect opt-outs and WhatsApp’s 24-hour/template rules. [WhatsApp policy](https://whatsappbusiness.com/policy/)

## Operations And Acceptance Gates
- Use n8n only for authenticated internal Telegram lead/emergency alerts and later CRM actions; PostgreSQL remains authoritative. Disable n8n public API after confirming no existing workflow depends on it.
- Create encrypted database snapshots on startup and scheduled uptime, retain 45 daily plus 6 monthly copies, and upload encrypted archives to cloud storage only when an operator requests it. Perform quarterly restore tests.
- Alert Telegram when the host is on but the API, database, tunnel, or Harness endpoint is unhealthy; do not depend on n8n alone for stack-health alerts.
- Test with the Meta test number: webhook verification/signature rejection, message replay, manual takeover, stale offline events, bilingual FAQ quality, emergency escalation, consent/opt-out, deletion, backup restore, Harness fallback, and provider outage.
- Promote the real WhatsApp number only after coexistence and manual-app reply mirroring are confirmed. If Meta does not offer coexistence, stop without modifying the production number and make a separate migration decision.
