# Repository Instructions

## Start Here

- Read `docs/PLAN.md`, `docs/TODO.md`, and `docs/PROJECT_CONTEXT.md` before changing code or infrastructure.
- Treat this repository as pre-implementation until the Phase 0 checks in `docs/PLAN.md` pass.
- Select work from the first unblocked tracker row whose dependencies and approval boundary are satisfied.
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
- Follow `docs/SYNTHETIC_FIXTURE_POLICY.md` for every fixture, seed, example, evaluation prompt, diagnostic artifact, and evidence update.

## Validation Gates

- No production launch until the Meta test-number, signature rejection, duplicate/retry, stale-event, bilingual-answer, human-takeover, opt-in/out, deletion, backup-restore, and model-fallback tests pass.
- If WhatsApp coexistence is unavailable, stop before changing the production number and request a separate migration decision.

## Antigravity (agy) Governance and Gate Scope

- Treat `agy-quality-and-security-gate` as a blocking static quality and heuristic secret/fixture pattern gate (`npm run validate:phase0`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev --audit-level=high`, `node scripts/verify-security-policy.ts`, and `node scripts/verify-pr-handoff.ts`); never bypass it with `continue-on-error` or skipped steps.
- Treat `agy-ui-ux-responsive-a11y-gate` and `agy-seo-and-identity-gate` as non-blocking source-text audit scaffolds by default (`AGY_STRICT_UI_GATE=false`, `AGY_STRICT_SEO_GATE=false`). Their scripts inspect source templates and headers and do **not** verify rendered viewports, horizontal overflow, WCAG 2.2 AA axe rules, live metadata, or route isolation; Playwright/axe/Lighthouse browser verification remains explicit future work.
- Preserve the approved reply and model policy: approved FAQ and business facts take precedence over generation, and when needed, the dedicated Manifest Harness `fcd-support` (`model: "auto"`, tool-free, with sensitive-data redaction) provides bounded generation and provider fallback. Never render drafts, rejected, retired, superseded, audit, customer, credential, or internal provenance records into customer replies.
- Preserve the webhook-only public exposure boundary (`GET /webhooks/meta` and `POST /webhooks/meta` only). Any public Support & Trust Center (`US-105`), operator inbox/staff lifecycle UI (`US-101`..`US-104`), or owner-deferred direct external notification adapter remains an unapproved proposal unless separately designed and approved.
- Record exact commands, outcomes, scope/tracker references, and rollback notes in every pull request. Section/heading checks in `scripts/verify-pr-handoff.ts` do not verify linked artifacts, story approval, or actual test execution.
