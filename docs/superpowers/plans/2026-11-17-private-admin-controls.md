# Track 2B Implementation Plan: Private Admin Operator Controls & UI/UX Contract

> **For agentic workers:** Follow `test-driven-development` strictly (`RED -> GREEN`), keep functions modular, run `prettier` + `validate:phase0` + `lint` + `typecheck` + `test` + PostgreSQL integration + `AGY_STRICT_UI_GATE=true`, and stack cleanly on `codex/track2a-gateway-policy`.

**Goal:** Implement full private operator dashboard controls (`/accounts`, `/pause`, `/privacy`, `/consent`, `/knowledge/import`, `/knowledge` replacement drafts, `/questions` dismissal, `/insights` aggregation/digest runs) and satisfy all 5 strict `scripts/verify-ui-ux-contract.ts` rules.

---

### Task 1: Schema Migration `000018`, Schema Head References, and Least-Privilege Grants

- **Create** `migrations/000018_create_private_admin_controls.ts`:
  - Expand `admin_audit_events_action_check` and `admin_audit_events_object_type_check`.
  - Allow audited `reviewer` 24h manual pauses in `human_pause_events` and update `enforce_human_pause_authority()` (`up` and clean rollback `down`).
  - Add `contacts.preferred_language` (`'en' | 'bn' | null`) and `privacy_access_runs.bundle_sha256`.
  - Add metadata-only views `admin_pause_states_v`, `admin_privacy_requests_v`, `admin_privacy_locations_v`, `admin_consent_identities_v` and closed-body `SECURITY DEFINER` admin workflow routines.
- **Modify** `src/persistence/postgres-runtime-grants.ts`:
  - Register `admin_pause_states_v`, `admin_privacy_requests_v`, `admin_privacy_locations_v`, `admin_consent_identities_v` in `knownViews`, grant `select` to `admin` ONLY.
  - Register all `admin_*` functions in the `security definer` + `search_path` hardening list and grant `execute` to `admin` ONLY (keep `webhook_receipts`, `webhook_events`, `support_escalation_outcomes`, `privacy_requests`, `conversations`, `channel_identities` negative table controls untouched).
- **Update** schema head assertions `'000017'` / `17` -> `'000018'` / `18` across `tests/`, `scripts/test-health-stdio-docker.sh`, and add migration `000018` tests in `tests/integration/migrations.test.ts` and `tests/integration/postgres-runtime-grants.test.ts`.

### Task 2: Domain Services (`identity`, `takeover`, `learning`, `correction`, `website-import`, `secret-files`)

- **Create** `src/knowledge/website-import.ts`: SSRF-safe public `https://` bounded fetch + safe HTML text extraction (`extractWebsiteContent`).
- **Modify** `src/operations/secret-files.ts`, `src/operations/compose-contract.ts`, `src/admin/admin-config.ts`, `src/admin/admin-runtime.ts`: wire optional `PRIVACY_HMAC_KEYRING` for `'admin'`.
- **Modify** `src/persistence/postgres-admin-identity.ts`: add `listAccounts`, `disableAccount` (forbidding last-active-admin revocation & revoking all sessions + credentials atomically), and TOTP Base32/URI helper in `src/admin/mfa.ts`.
- **Modify** `src/persistence/postgres-takeover-policy.ts`: add `pauseByReviewer` (for direct service callers).
- **Modify** `src/persistence/postgres-correction-policy.ts`: register safe `'preferred_language'` (`'en' | 'bn'`) production handler.
- **Modify** `src/persistence/postgres-learning-service.ts`: add `dismissOwnerQuestion`.

### Task 3: Dashboard Backend (`src/persistence/postgres-admin-dashboard.ts` & Action Tokens)

- Extend `AdminActionKind` in `src/admin/admin-action.ts`.
- Add audited backend methods in `src/persistence/postgres-admin-dashboard.ts` for:
  - Staff accounts: `listAccounts`, `createStaffAccount`, `assignStaffRole`, `revokeStaffRole`, `revokeStaffSessions`, `disableStaffAccount`.
  - Pause/Resume: `listPauseStates`, `pauseConversation`, `resumeConversation`.
  - Privacy/Deletion/Access/Correction: `listPrivacyRequests`, `listPrivacyLocations`, `reviewDeletionRequest`, `executeDeletionRequest`, `reviewPrivacyRequest`, `collectPrivacyAccessExport`, `executePrivacyCorrection`, `attestPrivacyLocation`.
  - Consent/Outbound: `listConsentIdentities`, `recordReviewerConsent`, `recordExplicitReoptIn`, `listOutboundPolicies`, `createOutboundPolicy`, `transitionOutboundPolicy`, `listOutboundTemplates`, `createOutboundTemplate`, `transitionOutboundTemplate`.
  - Knowledge/Learning: `importWebsiteDraft`, `createReplacementKnowledgeProposal` / draft edit, `dismissQuestion`, `triggerInsightAggregation`, `triggerQuestionDigest`.

### Task 4: Private Web Routes & Responsive Accessible UI (`admin-app.ts`, `admin-html.ts`, `operations-html.ts`)

- Update CSS & HTML components in `src/admin/admin-html.ts` and `src/admin/operations-html.ts` so ALL 5 checks in `scripts/verify-ui-ux-contract.ts` pass under `AGY_STRICT_UI_GATE=true` (`skip-link` + `#main-content`, `44px` controls, dark theme, `data-label=`, `role="alert"`).
- Add authenticated CSRF/origin/action-token routes and pages in `src/admin/admin-app.ts` and `src/admin/admin-html.ts`:
  - `/accounts` (`administrator` only)
  - `/pause` (`support_reviewer` or `administrator`)
  - `/privacy` (`support_reviewer`)
  - `/consent` (`support_reviewer` for consent/re-opt-in; `administrator` for outbound policies & fixed templates)
  - `/knowledge/import`, `/knowledge/:versionRef` replacement draft editor
  - `/questions/:questionRef/dismiss`
  - `/insights/aggregate`, `/insights/digest`

### Task 5: Full TDD & Multi-Environment Verification + Stacked Draft PR #27

- Run Prettier (including `--ignore-path .gitignore` on new docs), `AGY_STRICT_UI_GATE=true node scripts/verify-ui-ux-contract.ts`, `npm run check`, `node scripts/verify-security-policy.ts`, `npm audit --omit=dev --audit-level=high`.
- Run WSL PostgreSQL 18 integration suites (`migrations`, `postgres-runtime-grants`, `postgres-admin-dashboard`, `postgres-admin-dashboard-grants` unchanged negative controls, plus new `postgres-admin-controls.test.ts`).
- Run Linux `16 MiB /tmp` check (`bash scripts/test-encrypted-backup.sh unit` / `grants`).
- Commit, push `codex/track2b-admin-controls`, and open stacked Draft PR #27 (`--base codex/track2a-gateway-policy`).
