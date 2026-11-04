# Admin Dashboard Permissions Results

Date: 2026-11-04 (Asia/Dhaka).
Branch: `codex/agy-admin-dashboard-permissions`.
Base Commit: `3685ae0de131e218d1eb946dd60d726aa43f3706`.
Authority Boundary: Repository fixes, regression tests, and documentation only. Codex owns review, merge, current-server recovery/disposition, and server deployment. No SSH, shared-server Docker commands, provider/model/Manifest/n8n/Meta calls, public DNS/tunnel changes, or production actions were executed.

---

## 1. Summary of Changes

This package addresses Priority 0 from `docs/handoffs/2026-11-03-antigravity-priorities.md` and the review corrections from `docs/handoffs/2026-11-04-antigravity-review-corrections.md` (and review `docs/reviews/2026-11-04-pr-9-10-11-review.md`).

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

### Smallest Grant Correction Retained
In `src/persistence/postgres-runtime-grants.ts:464-468`, exactly 5 column-scoped SELECT grants were added to the `admin` role:
```typescript
await grant('admin', 'select(id,channel_identity_id)', ['conversations']);
await grant('admin', 'select(id,contact_id,external_contact_id)', [
  'channel_identities',
]);
await grant('admin', 'select(id,contact_id)', ['webhook_events']);
await grant('admin', 'select(contact_id,state)', ['privacy_requests']);
await grant('admin', 'select(reason_code,state)', [
  'support_escalation_outcomes',
]);
```
No whole tables were granted. Unpermitted columns (e.g., webhook message text, payload bodies, raw receipt metadata, access tokens) remain strictly denied. Mutations (INSERT, UPDATE, DELETE) and DDL on these tables remain completely denied.

---

## 2. Independent RED Reproduction Evidence

Prior to modifying `src/persistence/postgres-runtime-grants.ts`, each of the six operations fails independently under the nonsuperuser runtime admin role (`${rolePrefix}_admin`) initialized by `configureRuntimeGrants`. The test suite structures these as 6 separate, independent test cases so no failure masks or suppresses another:

1. **SQL `dashboard.listQuestions()`**:
   - SQLSTATE 42501: `permission denied for table conversations`
2. **SQL `dashboard.listInsights()`**:
   - SQLSTATE 42501: `permission denied for table conversations`
3. **SQL `dashboard.listEscalationCounts()`**:
   - SQLSTATE 42501: `permission denied for table support_escalation_outcomes`
4. **HTTP `GET /questions` (authenticated as admin)**:
   - HTTP 500 (Internal Server Error)
5. **HTTP `GET /insights` (authenticated as admin)**:
   - HTTP 500 (Internal Server Error)
6. **HTTP `GET /escalations` (authenticated as reviewer)**:
   - HTTP 500 (Internal Server Error)

---

## 3. GREEN Verification & Acceptance Evidence

After applying the 5 column-scoped grants, the expanded regression suite passes completely (`13 passed` in `2.43s` on local PostgreSQL):

### 1. Independent Empty States
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

### 3. Distinct-Person Count vs. Occurrence Count
- Created events for 2 distinct persons with 4 total observations (2 observations per person, each linked to a distinct `source_webhook_event_id`).
- Occurrence count = 4 (>= 3 minimum_group_count), but distinct person count = 2 (< 3 minimum_group_count).
- `dashboard.listInsights()` and `dashboard.listQuestions()` suppress the aggregates.
- Authenticated `GET /insights` and `GET /questions` do not contain the suppressed aggregates.
- **Positive Control**: Added a 3rd distinct person with an observation (distinct person count = 3 >= 3). Aggregates immediately become eligible in both SQL and authenticated HTTP.

### 4. Actual Retention Purge Boundary
- In `conversation_retention_states`, set `content_purged_through_at = anchor_at` (satisfying check constraint `content_purged_through_at <= anchor_at`).
- Immediate suppression: `listInsights()` and `listQuestions()` return `[]`; authenticated HTTP returns HTTP 200 with empty UI.
- Positive control: Reset `content_purged_through_at = null`; aggregates immediately reappear in both SQL and HTTP.

### 5. Expired Observations & Configurable Evaluation-Time
- Seeded observations with `retention_deadline = at + 5 minutes`.
- At current evaluation time `at`, observations are eligible.
- Advanced evaluation time by 10 minutes (600,000ms), exceeding observation retention deadline while remaining within the 1-hour admin session TTL.
- Immediate suppression: `listInsights()` and `listQuestions()` return `[]`; authenticated HTTP returns HTTP 200 with empty UI.

### 6. Live Privacy Suppression & Deletion Checks
- **Privacy hold**: Inserting a `privacy_requests` row (`received`) for one contact reduces distinct eligible contacts below `minimum_group_count` (3); `listInsights()` and `listQuestions()` immediately suppress the ineligible aggregates (returning `[]`). Removing the request restores eligibility.
- **Soft deletion**: Setting `external_contact_id = 'deleted:' || ...` reduces distinct eligible contacts below threshold; queries immediately suppress ineligible aggregates.

### 7. Negative Privilege Controls
The restricted `admin` role was tested directly against PostgreSQL:
- **Individual column read denials on ungranted table `webhook_receipts`**:
  - `select id from webhook_receipts` -> SQLSTATE 42501
  - `select payload_sha256 from webhook_receipts` -> SQLSTATE 42501
  - `select received_at from webhook_receipts` -> SQLSTATE 42501
  - `select event_count from webhook_receipts` -> SQLSTATE 42501
  - `select * from webhook_receipts` -> SQLSTATE 42501
- **Individual ungranted column read denials on partially granted tables**:
  - `webhook_events`: 10 ungranted columns (`receipt_id`, `idempotency_key`, `channel`, `event_kind`, `channel_account_id`, `external_message_id`, `occurred_at`, `message_text`, `message_status`, `reason_code`) -> all rejected with SQLSTATE 42501
  - `support_escalation_outcomes`: 8 ungranted columns (`id`, `escalation_ref`, `conversation_id`, `source_webhook_event_id`, `request_key`, `created_at`, `updated_at`, `resolved_at`) -> all rejected with SQLSTATE 42501
  - `privacy_requests`: 6 ungranted columns (`id`, `request_ref`, `request_type`, `received_at`, `open_request_key`, `updated_at`) -> all rejected with SQLSTATE 42501
  - `channel_identities`: 4 ungranted columns (`channel`, `channel_account_id`, `first_seen_at`, `last_seen_at`) -> all rejected with SQLSTATE 42501
  - `conversations`: 3 ungranted columns (`created_at`, `last_activity_at`, `updated_at`) -> all rejected with SQLSTATE 42501
- **Denied mutations (INSERT, UPDATE, DELETE)**:
  - `conversations`: INSERT, UPDATE, DELETE all rejected with SQLSTATE 42501
  - `channel_identities`: INSERT, UPDATE, DELETE all rejected with SQLSTATE 42501
  - `webhook_events`: INSERT, UPDATE, DELETE all rejected with SQLSTATE 42501
  - `privacy_requests`: INSERT, UPDATE, DELETE all rejected with SQLSTATE 42501
  - `support_escalation_outcomes`: INSERT, UPDATE, DELETE all rejected with SQLSTATE 42501
- **Denied DDL**:
  - `create table test_admin_ddl (id int)` -> SQLSTATE 42501
  - `drop table conversations` -> SQLSTATE 42501

### 8. Authentication & RBAC Matrix
- **Unauthenticated**: HTTP 303 Redirect to `/login` for all routes.
- **Revoked session**: HTTP 303 Redirect to `/login` for all routes.
- **Role separation**: Admin cannot access reviewer-only `/escalations` (HTTP 403); editor cannot access admin routes `/policy`, `/audit`, `/operations` (HTTP 403).

---

## 4. Verification Check Results

| Check | Command | Result |
| --- | --- | --- |
| Phase 0 Gate | `npm run validate:phase0` | **PASS** (exit 0) |
| ESLint | `npm run lint` | **PASS** (exit 0, 0 errors, 0 warnings) |
| TypeScript Check | `npm run typecheck` (`tsc --noEmit`) | **PASS** (exit 0) |
| TypeScript Build | `npm run build` | **PASS** (exit 0) |
| Git Whitespace Check | `git diff --check` | **PASS** (exit 0) |
| New Integration Tests | `npm run test:integration -- tests/integration/postgres-admin-dashboard-grants.test.ts` | **PASS** (13 passed, 0 failed, 2.43s) |
| Existing Dashboard Tests | `npm run test:integration -- tests/integration/postgres-admin-dashboard.test.ts` | **PASS** (8 passed, 0 failed, 1.05s) |
| Existing Grants Tests | `npm run test:integration -- tests/integration/postgres-runtime-grants.test.ts` | **PASS** (45 passed, 1 skipped, 3.97s) |
| Grants Unit Tests | `npm test -- tests/postgres-runtime-grants.test.ts` | **PASS** (3 passed, 0 failed, 0.08s) |

---

## 5. Next Steps

1. Commit and push updated branch `codex/agy-admin-dashboard-permissions` to keep PR #9 draft.
2. Proceed to PR #10 observer and actor cleanup corrections.
