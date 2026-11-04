# Fast Cyber Defense Support (`fcd-support`) - Antigravity GitHub Actions & Repository Governance

## Current governance state

The audit found boilerplate `SECURITY.md`, no `.github/CODEOWNERS`, no Dependabot configuration, no PR template, mutable CodeQL action references, and no dedicated gates for responsive UI, WCAG 2.2 AA, public SEO/GEO contracts, secret/fixture policy, or Ralph/GSD handoff evidence.

## Implemented in this branch

- `SECURITY.md` replacement with Fast Cyber Defense disclosure boundaries.
- `AGENTS.md` Antigravity launch-enforcement rules.
- `.github/CODEOWNERS` for high-risk paths.
- `.github/dependabot.yml` for npm and GitHub Actions.
- `.github/pull_request_template.md` for stories, evidence, security, SEO and accessibility impact.
- Immutable checkout pin in `.github/workflows/codeql.yml`.
- `.github/workflows/agy-quality-and-security-gate.yml`.
- `.github/workflows/agy-ui-ux-responsive-a11y-gate.yml`.
- `.github/workflows/agy-seo-and-identity-gate.yml`.
- `scripts/verify-security-policy.ts`.
- `scripts/verify-pr-handoff.ts`.
- `scripts/verify-ui-ux-contract.ts`.
- `scripts/verify-seo-contract.ts`.

## Gate behavior

The UI and SEO scripts start in audit mode so this governance PR does not pretend missing product surfaces are implemented. Set repository variables `AGY_STRICT_UI_GATE=true` and `AGY_STRICT_SEO_GATE=true` only after the Gate 1 UI and public SEO implementations land. Then require the workflows as branch-protection checks.

## Important implementation note

The current browser/axe/Lighthouse requirements remain future work. These workflows are a safe enforcement scaffold, not evidence that the current webhook-only service already has public pages or browser-tested accessibility. Add Playwright/axe/Lighthouse as pinned dependencies when the public Support & Trust Center and browser-test harness are implemented.
