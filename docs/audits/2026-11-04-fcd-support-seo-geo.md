# Fast Cyber Defense Support (`fcd-support`) - SEO, GEO and Search Discoverability

## Current verdict

The current application is webhook-only: `src/app.ts` serves only `GET/POST /webhooks/meta` and returns plaintext 404 for `/`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, and `/.well-known/security.txt`. Googlebot, Bingbot and AI search systems therefore have no crawlable Support & Trust Center content.

Do not make webhooks or admin routes indexable. Keep them privately routed and add `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and `Cache-Control: no-store` as defense in depth.

## Recommended topology

- Public `support.fastcyberdefense.com` or `/support`: separate read-only renderer.
- Private admin Unix-socket service.
- Webhook origin exposing only Meta verification/event paths.
- Public renderer reads only approved, current, published knowledge records.

## Required public SEO contract

- Unique title and 120-160 character description.
- Self-referential canonical per locale.
- Reciprocal `hreflang="en"`, `hreflang="bn-BD"`, `hreflang="x-default"`.
- OpenGraph and Twitter/X metadata with deterministic 1200x630 images.
- JSON-LD graph for `Organization`, `ProfessionalService`, `ContactPoint`, `WebSite`, `SearchAction`, `FAQPage`, and `BreadcrumbList`.
- `robots.txt`, dynamic `sitemap.xml`, `manifest.webmanifest`, RFC 9116 `/.well-known/security.txt`.
- Bing Webmaster verification and IndexNow notification on approved FAQ publication/replacement/retirement.
- Public, approved-only `/llms.txt` and `/llms-full.txt`; never publish customer transcripts or private provenance.
- Lighthouse targets: performance >=90, SEO >=95, accessibility >=95; LCP <=2.5s, INP <=200ms, CLS <=0.1.

## Search architecture rule

Do not add a fabricated SEO page to the webhook service just to make CI green. Build a separate public content service or explicitly routed public surface, then enable strict SEO gates after the actual resources exist.
