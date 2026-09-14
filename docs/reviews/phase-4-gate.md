# Phase 4 Gate Review

Decision: **PASS — local Phase 4 complete; Phase 5 planning authorized**

Authority scope: local_design_and_implementation_only

External or production action authorization: false

Reviewed baseline: 9dceb5ead56b6011328535ac2d2d0e00d9aa2781 plus the Task 17
change set containing this gate

Reviewed: 2026-09-14 (Asia/Dhaka)

Authority: the project owner approved the Phase 4 architecture/plan, instructed
Codex to complete Phase 4, and delegated remaining local approvals. This gate
uses that delegation for local code, synthetic fixtures, documentation, and
isolated PostgreSQL tests only.

## Evidence review

| Scope | Tracker rows | Result |
|---|---|---|
| Knowledge authority and publication | P4-002 | Immutable PostgreSQL versions, provenance, separate review/publication, retirement/rollback, private admin identity, and proposal-only owner answers pass locally. |
| FAQ and sensitive-data boundary | P4-003 | Sensitive inspection precedes exact-first effective FAQ resolution; blocked data bypasses inference; FAQ answers are exact reviewed text; misses remain minimized gaps. |
| Manifest contract | P4-004 | Builder-issued bounded auto requests contain no tools/provider override; one private-endpoint attempt and strict English/Bangla output validation pass against local fakes. |
| Policy, limits, safe failure | P4-005 | Explicit customizable reviewed limits, three-source restriction, rolling/global counters, cooldown, concurrency/queue leases, replay/expiry, deterministic safe drafts, and linked content-free escalation pass. |
| Bilingual evaluation | P4-006 | 35 newly authored synthetic cases (18 English, 17 Bangla), all seven declared local-fake invariants at 100%, 12/12 self-reviewed scripted outcomes acceptable, and zero critical failures. Independent human/real-provider scoring remains a later test-asset gate. |

## Validation

- npm run check: PASS — Phase 0 validation, formatting, lint, strict type
  checking, 473 tests across 39 files, and build.
- Guarded PostgreSQL suite through infra/compose.test.yml: PASS — 345 tests
  across 27 files.
- Model-flow suite: 10/10 PASS, covering exact replay, crash/expiry,
  customized limits, safe timeout, active-lease authority,
  grounding/publication races, and Phase 3 guard precedence.
- Evaluation scorer negative controls reject any invariant miss, sub-90%
  quality, critical failure, or invalid provenance.
- All evidence is local and synthetic.

## Gate findings

1. PostgreSQL remains authoritative; proposal sources and models cannot
   publish.
2. FAQ and sensitive decisions consume no allowance and issue no Manifest
   request.
3. The model stage requires an authoritative FAQ gap, uses one logical request,
   provides no tools, and can store only a fact-grounded draft or deterministic
   safe failure.
4. Completion-time takeover, privacy, deletion, retention, and knowledge
   publication checks override model output.
5. A review regression found and closed an unlabeled-separator test-card
   detection gap.
6. No outbound provider path exists in Phase 4, so no reply was sent.

## Deferred, binding gates

| Open work | Required gate |
|---|---|
| Manifest recording-off, private-network attachment, provider allowlist/order/limits, deletion behavior, and real-provider bilingual quality | P6 private deployment controls and P7-005 test-asset execution |
| PostgreSQL outbox, provider adapters, send-time eligibility, retries, correlation, and outbound rate limits | P5-002 through P5-005 and P5-GATE |
| Encrypted backup/restore operations, monitoring, sanitized alerts, and private n8n notification delivery | P6-002 through P6-006 and P6-GATE |
| Meta permissions/version, deployed outage tests, WhatsApp coexistence, and production readiness | P7/P8 gates |
| Any production deployment or production WhatsApp/Page mutation | Separate PROD-001/PROD-002 plan and immediate explicit approval |

## Decision

P4-GATE passes for local implementation because P4-002 through P4-006 meet the
approved local evidence standard. The next unblocked tracker row is P5-001,
which may design and document the test-first outbound implementation. This
gate does not authorize deployment, live Manifest/provider traffic, public
route expansion, Meta sends, customer data, n8n actions, or production changes.

P1-GATE remains a separate historical review record.
