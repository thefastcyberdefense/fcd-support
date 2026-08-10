# Repository Instructions

## Start Here

- Read `docs/PLAN.md` and `docs/PROJECT_CONTEXT.md` before changing code or infrastructure.
- Treat this repository as pre-implementation until the Phase 0 checks in `docs/PLAN.md` pass.
- Preserve the existing production WhatsApp Business account. Use a Meta test number first and do not unlink, migrate, or re-register the production number without explicit approval.

## Security Boundaries

- Never commit, print, or paste API keys, access tokens, passwords, phone-number IDs, tunnel credentials, database dumps, raw chat exports, or customer data.
- Keep OpenClaw and Hermes outside the public customer-support path and do not reuse their API keys.
- Expose only the Meta verification and event webhook paths through Cloudflare Tunnel. Keep admin, health, database, n8n, Manifest, and OmniRoute interfaces private.
- Verify Meta webhook signatures before parsing or storing payloads. Deduplicate event IDs and reject stale events after server downtime.
- Models receive no tools. Redact credentials, OTPs, payment data, and sensitive incident evidence before inference.

## Development Rules

- Use TypeScript with strict type checking and tests for webhook verification, event replay, human takeover, retention, consent, and provider fallback.
- Keep PostgreSQL as the authoritative state store. n8n may trigger notifications and workflows but must not own conversation or consent state.
- Use the dedicated Manifest Harness and API configuration named `fcd-support`; request model `auto` through that harness only.
- Pin container images and production dependencies. Run containers as non-root with read-only filesystems where compatible, explicit health checks, and CPU/memory limits.
- Keep changes focused on the approved plan. Document any change to retention, consent, public exposure, Meta onboarding, or production-number behavior before implementation.

## Validation Gates

- No production launch until the Meta test-number, signature rejection, duplicate/retry, stale-event, bilingual-answer, human-takeover, opt-in/out, deletion, backup-restore, and model-fallback tests pass.
- If WhatsApp coexistence is unavailable, stop before changing the production number and request a separate migration decision.
