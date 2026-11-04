# Fast Cyber Defense Support (`fcd-support`) - UI/UX, Responsiveness, Accessibility & Brand Identity

## Current verdict

The admin console has a useful server-rendered security baseline, but it is not yet a WCAG 2.2 AA-ready SOC-grade responsive system.

## High-impact UI/UX findings

- Mobile knowledge tables hide headers and turn cells into unlabeled blocks.
- Operations tables have a scroll wrapper but inherit the same mobile semantic break.
- The 901px-1024px tablet range keeps a fixed sidebar, large padding and a 386px detail panel, creating cramped layouts.
- Controls are 42px high; use 44px minimum for an incident-response console.
- Field focus uses a low-contrast pale ring; add a strong 3:1+ `:focus-visible` indicator to all controls.
- There is no skip link, dark mode, reduced-motion handling, forced-colors strategy, or robust mutation success/error feedback.
- Login/MFA notices lack `role="alert"`, field associations and reliable focus behavior.
- Destructive flows are protected by exact-reference confirmation, but the UI should explain impact and show post-action status.

## Required responsive matrix

Test `320-375px`, `390-480px`, `768-1024px`, `1280-1440px`, and `1920-2560px+`, plus 200%/400% zoom. Collapse the rail at approximately 1100px, preserve visible mobile cell labels, remove mobile `nowrap` overflow, and keep primary controls at least 44x44px.

## Recommended CSS/HTML direction

Use semantic tokens for light/dark cybersecurity surfaces, Inter/system UI for the operator console, JetBrains Mono for references, and Noto Sans Bengali first in Bangla font fallback. Add skip link and `main#main-content`, captions and `scope="col"`, `data-label` values for mobile cards, `role="alert"` errors, `role="status"` mutation feedback, strong focus rings, reduced motion, forced colors, and explicit disabled/loading states.

## Public identity architecture

- `fastcyberdefense.com`: canonical trust and conversion layer.
- `support.fastcyberdefense.com`: public bilingual Support & Trust Center, not the private admin origin.
- `blogs.fastcyberdefense.com`: practical security knowledge with authorship, dates, citations and methodology.
- LinkedIn, GitHub, WhatsApp Business, Facebook and `redwan.work`: align exact name, logo, domain, security contact and evidence-backed claims.

Use one identity ledger. Do not publish unsupported certifications, client logos, response metrics, or social accounts until ownership and evidence are verified.
