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

## Antigravity (agy) Launch Enforcement

- Treat `agy-quality-and-security-gate`, `agy-ui-ux-responsive-a11y-gate`, and `agy-seo-and-identity-gate` as blocking quality gates; never bypass them with `continue-on-error`, skipped jobs, or unreviewed baseline changes.
- Every public support answer must come from an approved, currently published knowledge version. Never render drafts, rejected, retired, superseded, audit, customer, credential, or internal provenance records.
- Public pages must have valid self-canonical URLs, reciprocal `en`/`bn-BD`/`x-default` alternates, OpenGraph/Twitter metadata, visible-content-equivalent JSON-LD, robots/sitemap/security resources, and no operational route exposure.
- Test public and private/admin pages at `320x568`, `390x844`, `768x1024`, `1440x900`, and `1920x1080`; require zero horizontal overflow (`scrollWidth <= clientWidth`), visible keyboard focus, `>= 44x44px` primary touch targets, and zero WCAG 2.2 AA axe violations.
- Record exact commands, artifact links, story/tracker IDs, and rollback evidence in every pull request. A green unit test alone is not handoff evidence.
