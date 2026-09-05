# Phase 4 Private Admin Checkpoint

## Scope

Date: 2026-09-05 (Asia/Dhaka). This completes Task 8 of the approved Phase 4
plan, following Task 7 revision `87aa4bf`. P4-002 remains in progress until
Task 9 is complete. This is not P4-GATE or deployment approval.

The separate admin process binds only to loopback. HTTPS/LAN access requires
the later private-TLS adapter. No admin route was added to the public webhook app.

## Verified Behavior

- Password/MFA login, session rotation/revocation, database-backed CSRF, exact
  Origin, current-role checks, and transactional knowledge authorization/audit.
- Bilingual draft creation, provenance, immutable replacement kind, previous
  version comparison, submission, approval/rejection, and manual publication.
- Expiring session-bound confirmations bind action, version, prior publication
  at the selected effective time, stable idempotency key, and timestamp.
- Scheduled publication, retirement, rollback, replay/conflict handling, and
  multiple pending versions per item; current and scheduled state stay distinct.
- Search/state filters run before bounded pagination. HTML is escaped; errors
  are content-free; CSP is restrictive; desktop/mobile controls are functional.
- Same-origin referrer policy preserves browser form Origin validation while
  suppressing cross-origin referrers.

## Validation Evidence

- `npm run check`: PASS; Phase 0 validator, formatting, lint, strict type
  checking, 278 unit tests across 27 files, and build.
- `docker compose -f infra/compose.test.yml run --rm runner`: PASS;
  277 guarded synthetic PostgreSQL tests across 20 files.
- Targeted failures were observed before fixes for replacement kind, scheduled
  confirmation wording, pagination, browser form Origin, and multi-version
  scheduled publication projections.
- Bundled Playwright 1.62.1 with Chromium, at 1440x1000 and 390x844: PASS for
  identity, meaningful content, no overlay, no console warnings/errors, no
  horizontal/panel clipping, and desktop/mobile screenshot inspection.
- Browser flow: login, MFA, replacement creation, submit, approve, exact-version
  publish, empty search, mobile navigation, and logout. Zero external requests.
  Real HTTP app; authored synthetic identity/dashboard doubles. PostgreSQL was
  validated separately, not through the browser preview.
- Browser plugin unavailable; no browser dependencies installed. Standard image
  viewing failed with the Windows sandbox ACL error; synthetic screenshots were
  inspected through approved local reads. Scripts/screenshots stayed outside Git.
- Independent targeted review found no remaining actionable findings after
  remediation. Staged scope/secret-pattern review and `git diff --check` passed.

## Remaining Boundaries

Question/insight surfaces exist; learning and owner-answer commands are Task 9.
Active policy and model-limit management await later Phase 4 tasks. This is not
a complete CRM or an outbound-delivery implementation.

No SSH deployment, Cloudflare/Meta/Manifest/n8n operation, live model/provider
call, customer-data access, real backup/restore, or production action occurred.
Manifest recording-off, private-network attachment, and provider-policy evidence
remain separately gated. Only local synthetic tests and browser previews ran.
