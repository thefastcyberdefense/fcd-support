# New Chat Handover Prompt

Use this prompt after opening a new Codex conversation in `J:\DevDrive\fcd-support`:

> Continue the Fast Cyber Defense customer-support project from this repository.
>
> Start by reading `AGENTS.md`, `README.md`, `docs/PLAN.md`, `docs/TODO.md`, and `docs/PROJECT_CONTEXT.md` completely. Inspect the current Git status and recent history before making changes. The repository is the source of truth; do not rely on assumptions from a previous chat.
>
> The goal is a dedicated, self-hosted TypeScript service for WhatsApp Business Cloud API and Facebook Messenger. It will run on the local Ubuntu Docker server at `redwan@192.168.10.40`, store authoritative data in local PostgreSQL, use the dedicated Manifest Harness `fcd-support` with model `auto`, and use private n8n workflows only for notifications and later CRM actions.
>
> Preserve these hard constraints:
>
> - Do not use OpenClaw or Hermes in the public customer-support execution path.
> - Do not change, unlink, migrate, or re-register the production WhatsApp Business number. Use a Meta test number first and stop if coexistence is unavailable.
> - Never commit or print secrets, customer data, raw chat exports, database dumps, or tunnel credentials.
> - Expose only signed Meta webhook verification and event paths through Cloudflare Tunnel. Keep admin, health, database, n8n, Manifest, and OmniRoute private.
> - Models receive no tools. FAQ and approved business facts take precedence over model generation.
> - Marketing requires explicit opt-in; blank means no promotional eligibility.
> - Casual chats are retained for 60 days, unconverted leads for 12 months, and human replies pause AI for 24 hours.
>
> Continue from the first unblocked row in `docs/TODO.md`. Complete the Phase 0 gate and approve the Phase 1 implementation plan before scaffolding. Use tests first for webhook signatures, replay/deduplication, stale events, human takeover, consent, retention, deletion, and model fallback. Do not deploy to the server or connect production Meta assets until the relevant local gates pass and the exact external action is approved.
>
> Keep me informed with concise progress updates. Continue autonomously on safe local implementation work, but stop for any action that would affect the production WhatsApp number, public DNS, Meta production permissions, live customer data, or irreversible server state.
