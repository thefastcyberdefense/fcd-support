# Admin Dashboard Permissions Results

Date: 2026-11-03 (Asia/Dhaka).  
Branch: `codex/agy-admin-dashboard-permissions`.  
Base Commit: `a39fbc387a35b5702b67a57b855c28ea0280f016`.  
Authority Boundary: Repository fixes, regression tests, and documentation only. Codex owns review, merge, current-server recovery/disposition, and server deployment. No SSH, shared-server Docker commands, provider/model/Manifest/n8n/Meta calls, public DNS/tunnel changes, or production actions were executed.

---

## 1. Summary of Changes

This package addresses Priority 0 from `docs/handoffs/2026-11-03-antigravity-priorities.md` and the confirmed reproduction in `docs/testing/2026-11-03-admin-dashboard-permissions.md`.

### Root Cause
Under `src/persistence/postgres-runtime-grants.ts`, the nonsuperuser `admin` role previously received table-wide SELECT on knowledge, admin, learning, model, outbound, runtime, operations, recovery, and conversation retention state tables, but lacked the required column-scoped SELECT permissions on five tables needed by:
1. `listQuestions()` and `listInsights()` in `src/persistence/postgres-admin-dashboard.ts` via the shared live privacy and retention join in `currentInsightEligibilityLateralSql` (`src/persistence/postgres-learning-service.ts`):
   - `conversations(id, channel_identity_id)`
   - `channel_identities(id, contact_id, external_contact_id)`
   - `webhook_events(id, contact_id)`
   - `privacy_requests(contact_id, state)`
2. `listEscalationCounts()` in `src/persistence/postgres-admin-dashboard.ts`:
   - `support_escalation_outcomes(reason_code, state)`

Under the deployed nonsuperuser admin login, all three list methods failed with SQLSTATE **42501** (`permission denied for table ...`), causing generic HTTP 500 errors on `/questions`, `/insights`, and `/escalations`.

### Smallest Grant Correction
In `src/persistence/postgres-runtime-grants.ts`, exactly 5 column-scoped SELECT grants were added to the `admin` role:
```typescript
await grant('admin', 'select(id,channel_identity_id)', ['conversations']);
await grant('admin', 'select(id,contact_id,external_contact_id)', ['channel_identities']);
await grant('admin', 'select(id,contact_id)', ['webhook_events']);
await grant('admin', 'select(contact_id,state)', ['privacy_requests']);
await grant('admin', 'select(reason_code,state)', ['support_escalation_outcomes']);
```
No whole tables were granted. Unpermitted columns (e.g., webhook message text, payload bodies, raw receipt metadata, access tokens) remain strictly denied. Mutations (INSERT, UPDATE, DELETE) and DDL on these tables remain completely denied.

---

## 2. RED Reproduction Evidence

Prior to modifying `src/persistence/postgres-runtime-grants.ts`, the regression suite `tests/integration/postgres-admin-dashboard-grants.test.ts` reproduced the exact failures under the nonsuperuser runtime admin role (`${rolePrefix}_admin`) initialized by `configureRuntimeGrants`:

```text
Direct list method failures:
- PostgresAdminDashboard.listQuestions():
  SQLSTATE 42501: permission denied for table conversations
- PostgresAdminDashboard.listInsights():
  SQLSTATE 42501: permission denied for table conversations
- PostgresAdminDashboard.listEscalationCounts():
  SQLSTATE 42501: permission denied for table support_escalation_outcomes

Authenticated HTTP GET route responses:
- GET /questions: HTTP 500 (Internal Server Error)
- GET /insights: HTTP 500 (Internal Server Error)
- GET /escalations: HTTP 500 (Internal Server Error)
```

---

## 3. GREEN Verification & Acceptance Evidence

After applying the 5 column-scoped grants, the regression suite passed completely (`5 passed` in `2.81s`).

### 1. Empty States
- `dashboard.listQuestions()` returns `[]`.
- `dashboard.listInsights()` returns `[]`.
- `dashboard.listEscalationCounts()` returns `[]`.
- Authenticated `GET /questions` returns HTTP 200 with empty state UI (`No owner questions are open.`).
- Authenticated `GET /insights` returns HTTP 200 with empty state UI (`No insights are recorded.`).
- Authenticated `GET /escalations` returns HTTP 200 with empty state UI (`No escalations are recorded.`).

### 2. Eligible Populated States
- Seeded 3 distinct synthetic customer contacts and events, 3 gap observations (`minimum_group_count = 3`), 1 insight run, 1 insight entry, 1 owner question, and 3 escalation outcomes (`faq_ambiguous: open` x 2, `sensitive_data_blocked: resolved` x 1).
- `dashboard.listQuestions()` returns the open question.
- `dashboard.listInsights()` returns `knowledge_coverage` with `occurrenceCount: 3`.
- `dashboard.listEscalationCounts()` returns grouped counts:
  - `{ reasonCode: 'faq_ambiguous', state: 'open', count: 2 }`
  - `{ reasonCode: 'sensitive_data_blocked', state: 'resolved', count: 1 }`
- Authenticated `GET /questions` returns HTTP 200 and renders the reviewed question text without leaking customer PSIDs or contact identifiers.
- Authenticated `GET /insights` returns HTTP 200 and renders topic/category codes without leaking customer data.
- Authenticated `GET /escalations` returns HTTP 200 and renders reason/state aggregates without leaking customer data.

### 3. Live Privacy Suppression & Retention Checks
- **Privacy hold**: Inserting a `privacy_requests` row (`received`) for one contact reduces distinct eligible contacts below `minimum_group_count` (3); `listInsights()` and `listQuestions()` immediately suppress the ineligible aggregates (returning `[]`). Removing the request restores eligibility.
- **Soft deletion**: Setting `external_contact_id = 'deleted:' || ...` reduces distinct eligible contacts below threshold; queries immediately suppress ineligible aggregates.
- **Retention purge**: Setting `conversation_retention_states.content_purged_through_at` past observation time suppresses the data.
- **Observation expiry**: Observations past their retention deadline are suppressed.

### 4. Negative Privilege Controls
The restricted `admin` role was tested directly against PostgreSQL:
- **Denied column reads** (SQLSTATE 42501):
  - `select message_text from webhook_events` -> rejected
  - `select * from webhook_receipts` -> rejected
  - `select id, escalation_ref from support_escalation_outcomes` -> rejected
  - `select request_ref from privacy_requests` -> rejected
- **Denied mutations** (SQLSTATE 42501):
  - `insert into conversations ...` -> rejected
  - `update conversations ...` -> rejected
  - `delete from conversations ...` -> rejected
  - `insert into channel_identities ...` -> rejected
  - `insert into webhook_events ...` -> rejected
  - `insert into privacy_requests ...` -> rejected
  - `insert into support_escalation_outcomes ...` -> rejected
  - `delete from support_escalation_outcomes ...` -> rejected
- **Denied DDL** (SQLSTATE 42501):
  - `create table test_admin_ddl (id int)` -> rejected
  - `drop table conversations` -> rejected

### 5. Authenticated GET Smoke Matrix
Tested across all sidebar modules (`/knowledge`, `/questions`, `/insights`, `/policy`, `/escalations`, `/audit`, `/operations`):
- **Administrator role**: HTTP 200 across all 7 sidebar routes.
- **Support reviewer role**: HTTP 200 on `/knowledge`, `/questions`, `/insights`, `/escalations`; HTTP 403 Forbidden on administrator-only routes (`/policy`, `/audit`, `/operations`).
- **Knowledge editor role**: HTTP 200 on `/knowledge`, `/questions`, `/insights`; HTTP 403 Forbidden on `/escalations`, `/policy`, `/audit`, `/operations`.
- **Unauthenticated**: HTTP 303 Redirect to `/login` for all routes.
- **Revoked session**: HTTP 303 Redirect to `/login` for all routes.

---

## 4. Verification Check Results

| Check | Command | Result |
| --- | --- | --- |
| Phase 0 Gate | `npm run validate:phase0` | **PASS** (exit 0) |
| Prettier | `npm run format:check` | **PASS** (exit 0, all files formatted) |
| ESLint | `npm run lint` | **PASS** (exit 0, 0 errors, 0 warnings) |
| TypeScript Check | `npm run typecheck` (`tsc --noEmit`) | **PASS** (exit 0) |
| TypeScript Build | `npm run build` | **PASS** (exit 0) |
| Git Whitespace Check | `git diff --check` | **PASS** (exit 0) |
| Secret Pattern Check | Custom scan for tokens, keys, passwords | **PASS** (only synthetic test values) |
| New Integration Tests | `vitest run tests/integration/postgres-admin-dashboard-grants.test.ts` | **PASS** (5 passed, 0 failed, 2.81s) |
| Existing Dashboard Tests | `vitest run tests/integration/postgres-admin-dashboard.test.ts` | **PASS** (8 passed, 0 failed, 1.78s) |
| Existing Grants Tests | `vitest run tests/integration/postgres-runtime-grants.test.ts` | **PASS** (45 passed, 1 skipped, 4.43s) |
| Grants Unit Tests | `vitest run tests/postgres-runtime-grants.test.ts` | **PASS** (3 passed, 0 failed, 0.40s) |

---

## 5. Next Steps

1. Commit and push branch `codex/agy-admin-dashboard-permissions`.
2. Open draft PR for Priority 0 review by Codex.
3. Proceed to Priority 1 (`docs/handoffs/2026-11-03-antigravity-health-transport-stress.md`) and Priority 2 (`docs/handoffs/2026-11-02-antigravity-phase-7-readiness.md`) on separate branches.
