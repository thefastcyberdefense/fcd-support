# Local And Test-Asset Acceptance Matrix

Status: reviewed Phase 0 acceptance design (`P0-018`)

Reviewed: 2026-08-27 (Asia/Dhaka)

This matrix defines how each repository validation gate is proven. Completing
this matrix means every requirement has an owner, method, expected result, and
evidence location. It does **not** mean every later-phase test already passes.

## Evidence Rules

- Fixtures, probes, evidence, and logs follow
  `docs/SYNTHETIC_FIXTURE_POLICY.md`; no raw customer data, identifiers, secrets,
  payloads, prompts, recordings, database dumps, or tunnel credentials may be
  retained.
- `LOCAL PASS` means the currently implemented local automated behavior passes.
- `TEST-ASSET PASS` means sanitized evidence from dedicated Meta test assets or
  the approved test deployment exists.
- `PARTIAL` means some layers pass but the complete gate does not.
- `PLANNED` means implementation/evidence belongs to a named later tracker row.
- `BLOCKED` means a required dependency or approval is not available.
- Only a full `PASS` at the named later gate clears a production launch blocker.

## AGENTS.md Launch-Gate Matrix

These rows map every validation gate named in `AGENTS.md:29`.

| ID | Required gate | Environment and method | Expected result | Current evidence and status | Owner / final gate |
|---|---|---|---|---|---|
| AC-01 | Meta test number | Development app + Meta-hosted test number. Verify callback/subscription, send signed synthetic webhook samples, then send a real role-scoped device message when Meta permits it. | Correct number/account scope reaches the exact callback; no production number is linked, unlinked, migrated, registered, or subscribed. | Callback, subscription, and signed v26 synthetic samples passed; real device-originated delivery did not reach the unpublished app. **PARTIAL**. `docs/operations/test-deployment.md:188`; `docs/operations/test-deployment.md:196`. | Operator + Codex / P7-005, P7-GATE |
| AC-02 | Signature rejection | Unit and Fastify injection tests alter raw bytes, omit/mangle headers, use malformed JSON/UTF-8, and assert the sink is untouched. Deployed probe sends unsigned synthetic JSON. | Missing/invalid signature returns `401` before parse/storage; valid raw-byte HMAC is accepted. | `tests/meta/verify-signature.test.ts`, `tests/app.test.ts`; deployed unsigned probe documented at `docs/operations/test-deployment.md:171`. **LOCAL PASS + TEST-ASSET PASS**. | Codex / regression gate |
| AC-03 | Duplicate/retry | PostgreSQL tests replay exact payloads and logical events across different payloads, concurrency, restart, and held locks; repeat one signed synthetic public probe. | Successful `200`, one logical event/application, no duplicate policy effect; bounded retry behavior. | `tests/integration/postgres-receipt-store.test.ts`, `tests/integration/durable-runtime.test.ts`; deployed exact retry at `docs/operations/test-deployment.md:174`. **LOCAL PASS + TEST-ASSET PASS**. | Codex / regression and P7-005 |
| AC-04 | Stale event | Synthetic provider timestamps cover five-minute boundary, excessive future skew, delayed statuses, out-of-order delivery, and restart. | Stale/future messages are minimal non-actionable records; status ordering remains monotonic; retention is not extended. | Admission/store behavior passes in `tests/integration/postgres-receipt-store.test.ts`; retention interaction is not implemented. **PARTIAL**. | Codex / P3-005 and P7-005 |
| AC-05 | Bilingual answer | Approved synthetic English/Bangla prompt set, FAQ-first assertions, human scoring, threshold approval, injection/sensitive-data cases, and provider failure cases. | Approved facts take precedence; both languages meet the approved quality/safety threshold; unsafe/unknown cases escalate without invention. | No approved evaluation set or model path. **PLANNED**. | Project owner + Codex / P4-006, P4-GATE, P7-005 |
| AC-06 | Human takeover | Guarded PostgreSQL tests cover echo application, exact retry, old/new echo ordering, 24-hour boundary, private authorized resume, concurrent resume/echo, and failure rollback. Test Page sends a manual Page reply; later deployment must run the async processor and assert pause state. | Uncorrelated staff echo pauses from provider time for 24 hours; duplicates do not extend; AI cannot send during pause; private authorized resume is race-safe. | 31 guarded policy tests previously passed; test Page echo reached durable admission only. **PARTIAL**. `tests/integration/postgres-takeover-policy.test.ts`; `docs/architecture/channel-behavior.md:112`. | Codex + operator / P3-GATE, P5-004, P7-005 |
| AC-07 | Opt-in/out | Guarded PostgreSQL tests cover exact channel/account/contact/category, blank/missing consent, grant, revoke, later re-grant, replay, concurrency, and unauthorized reviewer. Future outbound test rechecks immediately before send. | Only the latest explicit category-specific grant is eligible; blank/missing/revoked/cross-scope consent is denied. | Policy core passes; natural-language/channel command integration and send-time recheck are not implemented. **PARTIAL**. `tests/integration/postgres-consent-policy.test.ts`. | Codex / P3-GATE, P5-004, P7-005 |
| AC-08 | Deletion | Synthetic same-channel request, explicit confirmation, reviewer authorization, idempotent replay, exact/cross-channel identity, derived/outbound/recording cleanup, tombstone creation, and later-event resistance. | Verified identity is deleted once; no password/OTP/payment secret is requested; minimal suppression remains; later events do not resurrect data. | Policy contract exists; implementation absent. **PLANNED**. `docs/architecture/data-lifecycle.md:121`; `docs/architecture/data-lifecycle.md:222`. | Codex + project owner / P3-006, P3-GATE, P7-005 |
| AC-09 | Backup/restore | Create encrypted synthetic backup, restore into isolated database, load every unexpired tombstone/key version, reapply deletions, verify counts/digests only, and attempt promotion before/after gate. | Deleted content is not served; failed tombstone/reconciliation blocks application attachment and promotion; rollback is documented. | Contract exists; backup/restore automation absent. **PLANNED**. `docs/architecture/data-lifecycle.md:196`; `docs/architecture/data-lifecycle.md:231`. | Codex + operator / P6-004, P6-GATE, P7-005 |
| AC-10 | Model fallback | Local fake Manifest endpoint inspects tool-free `fcd-support`/`auto` request, redaction, timeouts, provider order/limits, safe failure, no OpenClaw/Hermes key reuse, and escalation outcome. Private test later confirms recording off without retaining bodies. | FAQ-first answer or approved provider result; no tools; no secret/sensitive evidence; only approved fallbacks; timeout/exhaustion escalates safely. | Inventory only; recording currently enabled and explicit fallback/limit policy unresolved. **BLOCKED**. `docs/operations/preflight-inventory.md:35`; `docs/operations/preflight-inventory.md:47`. | Codex + project owner / P4-004 through P4-006, P4-GATE, P7-005 |

## Security, Policy, And Operational Matrix

| ID | Requirement / threat | Test method | Acceptance criterion | Current status / evidence | Final gate |
|---|---|---|---|---|---|
| AC-11 | GET verification secrecy | Unit/Fastify matrix for missing mode, token, challenge, wrong token, arrays, and success; public challenge probe uses protected env without printing token. | Exact match returns challenge; every invalid form returns `403`; token absent from logs/evidence. | **PASS**: `tests/meta/verify-subscription.test.ts`, `tests/app.test.ts`. | Regression |
| AC-12 | Body and parser boundary | Synthetic body at/over 256 KiB, malformed JSON, invalid UTF-8, Unicode raw-byte HMAC. | Bounded rejection; signature always checks original bytes; sink remains untouched on rejection. | **PASS**: `tests/app.test.ts`. | Regression |
| AC-13 | Unsupported/malformed siblings | Synthetic WhatsApp and Messenger batches combine valid, unsupported, and malformed items. | Valid siblings persist; unsupported items have no model/outbound/consent/takeover side effect. | **PASS**: normalizer tests and `tests/integration/durable-runtime.test.ts`. | Regression |
| AC-14 | Durable-before-ack / DB outage | Guarded PostgreSQL test observes storage before response, unavailable database, held duplicate lock, rollback, and pool error. | No successful event `200` before commit; failures return bounded `503`; no sensitive error details. | **PASS**: `tests/integration/durable-runtime.test.ts`, `tests/runtime.test.ts`. | Regression + P7-005 outage |
| AC-15 | Identity isolation | Synthetic same external identifier across channel/account/contact; WhatsApp phone and `user_id:` variants; Messenger Page scope. | No identity/consent/conversation collision; invalid source never broadens scope. | **PASS** locally: normalizer and Phase 3A PostgreSQL tests. | Regression |
| AC-16 | Policy history integrity | Migration and concurrency tests attempt direct update/delete, non-pending references, audit failure, and transaction races. | Append-only authoritative history; invalid mutations fail and roll back all state. | **PASS**: `tests/integration/migrations.test.ts` and Phase 3A integration suites. | Regression |
| AC-17 | Retention anchors/boundaries | Property/table-driven synthetic UTC tests for 60 days, 12 calendar months, active-client +24 months, leap/end-of-month, precedence, promotion/downgrade, duplicates, statuses, AI-only activity, and replay. | Only qualifying anchors extend; exact boundary is eligible for deletion; verified deletion is terminal. | **PLANNED**: specification at `docs/architecture/data-lifecycle.md:212`; P3-005. | P3-GATE, P7-005 |
| AC-18 | Public route isolation | Contract tests inspect Compose/scripts; deployed verifier checks exact internal endpoints, no host ports, exact callback, ingress-only `/health` `404`, and unsigned `401`. | Only `GET/POST /webhooks/meta` reach app; database/admin/health/n8n/Manifest/OmniRoute stay private. | **PASS** for admission deployment: `tests/deployment-contract.test.ts`; `scripts/verify-test-deployment.sh`. Re-run after any tunnel/network change. | P6-GATE + P7-005 |
| AC-19 | Secrets/log/evidence privacy | Logger allowlist tests, config error tests, fixture policy scan, repository secret-pattern review, and sanitized evidence review. | No secret, signature, raw identity/content/payload/dump/recording in output or Git. | **PASS** for current repository scope: `tests/logging.test.ts`, `tests/config.test.ts`, fixture-policy review. | Every gate |
| AC-20 | Strict supply/runtime contract | `npm ci`, format, lint, strict typecheck, unit tests, build; Docker contract checks pinning, non-root, health, read-only/capability/resource limits, revision label. | All commands pass; exact pinned artifacts and revision are verifiable. | **PASS** locally for code/contract; deployed admission image previously verified. | CI/regression + P6-GATE |
| AC-21 | Manifest privacy and tool isolation | Local fake rejects any tool field, wrong harness/model, unredacted prohibited pattern, missing timeout/limit; private test verifies recording off and network isolation. | `fcd-support`, `auto`, no tools, approved providers/limits, recording off, private route only. | **BLOCKED** on P4 implementation/configuration. | P4-GATE, P6-GATE, P7-005 |
| AC-22 | FAQ precedence and sensitive-data redaction | Synthetic FAQ hit/miss, conflicting model output, credential/OTP/payment/incident evidence, prompt injection, and Bangla/English cases. | Approved fact wins; prohibited data never enters inference; uncertain or sensitive cases escalate. | **PLANNED**: P4-002 through P4-006. | P4-GATE, P7-005 |
| AC-23 | Outbox/provider exactly-once behavior | Local HTTP fake with crash before/after send, lease expiry, timeout/ambiguous response, duplicate workers, provider idempotency, status reorder, and restart. | One durable intent; no blind duplicate; monotonic terminal state; bounded retries and terminal escalation. | **PLANNED**: P5-002, P5-003, P5-005. | P5-GATE, P7-005 |
| AC-24 | Send-time eligibility | Race tests change pause, consent, deletion, suppression, service window, or template eligibility after draft and before send. | Eligibility is checked immediately before intent and provider send; any denial prevents send. | **PLANNED**: P5-004. | P5-GATE, P7-005 |
| AC-25 | Rate/cost limits | Synthetic account/contact bursts, provider 429, queue saturation, and Manifest timeout/budget exhaustion. | Per-scope limits hold, retries respect policy, no unbounded queue/cost, sanitized alert emitted. | **PLANNED**: P4-005, P5-005, P6-005. | P4/P5/P6 gates, P7-005 |
| AC-26 | n8n boundary | Local fake and private test validate authentication, idempotency, timeout, retry, payload minimization, and database authority during n8n outage. | n8n cannot alter authoritative state; no public dependency; failure does not lose core state. | Inventory **PASS**, integration **PLANNED**: P6-006. | P6-GATE, P7-005 |
| AC-27 | Tunnel/server outage and restart | Stop tunnel/API/database separately; replay signed synthetic events after restart; verify manual coverage procedure and no expanded route. | Safe unavailability, no duplicate effects after retry, sanitized alerts, manual staff coverage maintained. | Restart idempotency passes locally; live outage matrix **PLANNED**. | P7-005 |
| AC-28 | Meta version and permissions | Read-only inventory, supported-version decision, development-role tests, app review/live-permission checklist, token rotation drill without recording values. | One approved Graph version, least privileges, rotated/revoked tokens, live permission evidence before production. | Version mismatch and expired test token recorded; **BLOCKED** for production. | P7-GATE, P8-002 |
| AC-29 | WhatsApp coexistence/manual reply | Read-only eligibility check only after P7-GATE; use approved non-production coexistence evidence before any production mutation. Test staff manual-app echo, self-echo correlation, duplicate, stale, race, and no-go path. | Coexistence and takeover signal proven without changing production number; otherwise stop and request separate decision. | **BLOCKED**; test-number evidence does not prove coexistence. | P8-003, P8-004, P8-GATE |
| AC-30 | Production separation | Review exact action plan immediately before any DNS, server, app permission, live-data, production Page, or WhatsApp number mutation. | Explicit target-specific approval, rollback, evidence, and stop conditions; Phase/test passes alone never authorize action. | Boundary documented; no production action authorized. | PROD-001, PROD-002 |

## Execution Order And Evidence Record

1. Every local implementation row is added test-first and must pass `npm run check`.
2. PostgreSQL suites run only against the guarded exact synthetic test database.
3. Local provider behavior uses fakes; no live credential is needed for contract
   tests.
4. Test-asset actions require the tracker approval named in their row and retain
   only sanitized timestamps, outcomes, permission names, and Git revisions.
5. P7-005 executes every row applicable to the non-production stack, including
   outage, restart, and manual-echo cases.
6. P8 records app review, coexistence, ownership, and production readiness. It
   does not authorize production.
7. PROD-001/002 require a separate exact promotion/rollback plan and immediate
   approval.

The current next implementation work remains P3-005 retention, followed by
P3-006 deletion. Rows marked `PARTIAL`, `PLANNED`, or `BLOCKED` remain launch
blockers even though this Phase 0 acceptance design is complete.
