# Dashboard failures under the deployed admin database role

Date: 2026-11-03 (Asia/Dhaka).
Status: **CONFIRMED / correction pending.**

The owner reports HTTP 500 on `/questions`, `/insights` and `/escalations` after
successful login. Other displayed modules render. These are existing Phase 5/6
functions, not features deferred to Phase 7.

## Independent server reproduction

Source: `24e56679c9c29823b210ca6991608f83de556156`, private project
fcd-support-host-test-p6-b1e183d. A bounded diagnostic used the existing healthy
admin container, its actual configured nonsuperuser database login, compiled
`PostgresAdminDashboard` and `PostgresAdminIdentity`, and PostgreSQL
`default_transaction_read_only=on`. It called only three list methods and catalog
privilege predicates. It did not inspect browser cookies, authenticate as the
owner, change grants or records, or print data/error text.

All three compiled reads failed with SQLSTATE **42501** (permission denied):

- `listQuestions()` for `/questions`.
- `listInsights()` for `/insights`.
- `listEscalationCounts()` for `/escalations`.

The same restricted login lacks the required column reads in all five groups
below. Its nonsuperuser/read-only status was checked. Before/after inventory,
state-file fingerprints and the retirement survivor baseline matched. No server
correction or authenticated HTTP re-test is claimed.

## Source trace and missing test boundary

`src/persistence/postgres-admin-dashboard.ts` uses the shared current insight
eligibility join in `src/persistence/postgres-learning-service.ts`. The join
rechecks privacy, retention, source linkage and distinct-person thresholds at
read time. These queries require the following column reads:

| Table                       | Required SELECT columns             |
| --------------------------- | ----------------------------------- |
| conversations               | id, channel_identity_id             |
| channel_identities          | id, contact_id, external_contact_id |
| webhook_events              | id, contact_id                      |
| privacy_requests            | contact_id, state                   |
| support_escalation_outcomes | reason_code, state                  |

`src/persistence/postgres-runtime-grants.ts` does not grant these reads to the
admin database role. The first four groups serve the questions/insights joins;
the last serves grouped escalation counts. The HTTP error handler deliberately
returns a generic 500 without exposing the database error.

`tests/integration/postgres-admin-dashboard.test.ts` exercises dashboard logic
through a broader isolated fixture pool. The restricted admin test in
`tests/integration/postgres-runtime-grants.test.ts` proves password/MFA but does
not exercise these list methods or authenticated routes. That leaves the
deployment-specific privilege gap uncovered.

## Correction boundary

AGY owns a test-first source correction under
`../handoffs/2026-11-03-antigravity-priorities.md`. Reproduce with the actual
configured runtime admin login and authenticated application boundary. Add only
necessary column-scoped grants, preserve denied content/writes, and verify empty
and eligible populated states with privacy suppression controls. Do not replace
privacy eligibility with stored aggregates, catch errors as empty lists, or use
owner/superuser credentials in the runtime.

Codex retains review, merge and server rollout. The separate uncertain health
job still holds scheduled operations; it must not be cleared or bypassed to
deploy this correction. The original bounded Phase 6 closeout remains historical
evidence, with this subsequently discovered limitation recorded explicitly.
