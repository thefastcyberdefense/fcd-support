# Fast Cyber Defense Support (`fcd-support`) - UI/UX, Responsiveness, Accessibility & Brand Identity

- **Scope & Enforcement Status:** The private admin console (`src/admin/admin-app.ts`) is an internal Unix-socket/loopback server-rendered application. In PR #13, `scripts/verify-ui-ux-contract.ts` and `.github/workflows/agy-ui-ux-responsive-a11y-gate.yml` run as **non-blocking source-text scaffolds (`AGY_STRICT_UI_GATE=false`)** that inspect CSS/HTML strings in `src/admin/admin-app.ts` and do **not** perform rendered browser, viewport, horizontal-overflow, or axe WCAG 2.2 AA verification.

## Current Verdict

The private admin console (`src/admin/admin-app.ts`) has a strong security baseline—per-response CSP nonces, `SameSite=Strict` and `HttpOnly` session cookies, `Cache-Control: no-store`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and exact-reference confirmation for destructive actions—but several responsive layout and accessibility refinements remain future UI enhancement work.

## Source-Inspected Admin UI/UX Findings (Enhancement Backlog)

- **Mobile table layout (`src/admin/admin-app.ts`):** At narrow widths, knowledge and operations tables hide `<thead>` and stack cells as block elements without visible per-cell `data-label` attributes.
- **Tablet breakpoint density (`901px–1024px`):** The fixed sidebar, padding, and detail panel can crowd horizontal space before the single-column breakpoint triggers.
- **Interactive target sizing:** Buttons and inputs currently use a `42px` minimum height; increasing primary interactive controls to `>= 44x44px` is recommended for operator ergonomics.
- **Keyboard focus & landmarks:** Adding a skip link (`<a class="skip-link" href="#main-content">`), explicit `main#main-content` target, stronger `:focus-visible` outlines (`>= 3:1` contrast), `role="alert"` on login/MFA error banners, and `prefers-reduced-motion` / `forced-colors` media queries will improve keyboard and assistive-technology usability.
- **Theme tokens:** Dark/high-contrast SOC theme tokens remain an optional future enhancement proposal, not a launch blocker for the private admin tool.

## Future Browser Verification Matrix (Not Yet Active in CI)

When the admin UI refinements are scheduled and Playwright + `@axe-core/playwright` are added as pinned devDependencies, verify rendered pages across `320x568`, `390x844`, `768x1024`, `1440x900`, and `1920x1080` (plus `200%` zoom) for zero horizontal overflow (`scrollWidth <= clientWidth`), visible keyboard focus, `>= 44x44px` primary touch targets, and zero WCAG 2.2 AA axe violations. Until that browser harness exists, `scripts/verify-ui-ux-contract.ts` must only be described as a static source-text scaffold.

## Proposed Public Brand & Identity Architecture (Unapproved Proposal)

If the project owner separately approves a public web presence in the future (`US-105`), keep it strictly isolated from the private admin and webhook origins:

- `fastcyberdefense.com`: primary corporate site.
- `support.fastcyberdefense.com` (proposed): separate public bilingual Support & Trust Center renderer; never route to the private admin console.
- `blogs.fastcyberdefense.com`: security articles with verified authorship and citations.

Maintain a single owner-verified identity ledger. Do not publish unverified certifications, client logos, response-time SLAs, safe-harbor promises, or security contact addresses (`security@fastcyberdefense.com`) as binding commitments until owner/legal provenance is approved.
