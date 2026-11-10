# Fast Cyber Defense Support (`fcd-support`) - SEO, GEO and Crawler Isolation

- **Scope & Enforcement Status:** Per `AGENTS.md`, `fcd-support` exposes **only** `GET /webhooks/meta` and `POST /webhooks/meta` publicly through Cloudflare Tunnel, while keeping admin, health, database, Manifest, and n8n interfaces private. In PR #13, `scripts/verify-seo-contract.ts` and `.github/workflows/agy-seo-and-identity-gate.yml` run as **non-blocking source-text scaffolds (`AGY_STRICT_SEO_GATE=false`)** that inspect header strings in `src/app.ts` and `src/admin/admin-app.ts` and do **not** verify live HTTP routes, rendered metadata, or a public website.

## Current Verdict & Approved Exposure Boundary

`src/app.ts` intentionally serves only `GET /webhooks/meta` and `POST /webhooks/meta` and returns `404` for all other paths (`/`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/.well-known/security.txt`). This is the **approved security architecture** under `AGENTS.md`, not an accidental regression.

1. **Keep webhook and admin interfaces non-indexable:** Webhooks (`src/app.ts`) and the private admin console (`src/admin/admin-app.ts`) must never be indexed by search engines or AI crawlers. Adding `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` alongside existing `Cache-Control: no-store` headers on admin responses (`src/admin/admin-app.ts:226`) is a low-risk defense-in-depth hardening item.
2. **Preserve model fallback & knowledge rules:** Customer support replies on WhatsApp follow the approved reply pipeline (`src/operations/reply-pipeline.ts`): approved FAQ and business facts take precedence over generation, and when needed, the dedicated Manifest Harness `fcd-support` (`model: "auto"`, tool-free, with sensitive-data redaction) provides bounded generation and provider fallback.

## Proposed Public Support & Trust Center SEO Contract (Unapproved Proposal — `US-105`)

If and only if the project owner separately approves a public Support & Trust Center in the future, it must be deployed as a **separate read-only public service** (`support.fastcyberdefense.com`) rather than weakening the webhook-only boundary of `src/app.ts`. Under such a future approved design, the proposed public SEO contract would include:

- Unique locale titles and 120–160 character meta descriptions.
- Self-referential canonical URLs and reciprocal `hreflang="en"`, `hreflang="bn-BD"`, and `hreflang="x-default"` alternates.
- OpenGraph and Twitter/X metadata with deterministic social preview images.
- Validated JSON-LD (`Organization`, `ContactPoint`, `WebSite`, `FAQPage`, `BreadcrumbList`) derived strictly from owner-approved facts and published FAQ records.
- Public `robots.txt`, `sitemap.xml`, and owner-approved RFC 9116 `/.well-known/security.txt` (only after disclosure mailbox and safe-harbor provenance are approved).
- Approved-only public `/llms.txt` projections; never expose customer transcripts, drafts, rejected/retired knowledge, or internal provenance.

## Search Architecture Rule

Never add a fabricated landing page to `src/app.ts` or expose admin/health routes publicly just to turn an SEO check green. Keep `AGY_STRICT_SEO_GATE=false` unless a separate public surface is formally approved and implemented.
