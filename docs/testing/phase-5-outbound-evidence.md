# Phase 5 Outbound Messaging Evidence

Reviewed: 2026-09-20 (Asia/Dhaka)

Evidence scope: local code, loopback HTTP fakes, synthetic fixtures, and an
isolated Docker PostgreSQL test service only.

## Results

| Gate | Result |
|---|---|
| Focused Phase 5 unit suite | 164/164 tests across 8 files passed |
| Focused Phase 5 PostgreSQL suite | 68/68 tests across 8 files passed |
| Complete `npm run check` | 634/634 tests across 46 files; Phase 0 validator, formatting, lint, strict type checking, and build passed |
| Complete guarded PostgreSQL suite | 417/417 tests across 35 files passed |
| Cleanup aggregate | 0 leftover `test_*` schemas; 0 advisory locks |

## Covered Contracts

- Migration 000012 applies, rolls back only when safe, reapplies, rejects
  populated downgrade, and enforces closed states, immutable authority, and
  append-only evidence.
- Reviewed customizable policy/templates enforce authorization, request-key
  replay, state transitions, scope, locale, category, and concurrent activation.
- Intent creation and final authorization recheck pause, echo hold, privacy,
  deletion, suppression, exact consent, support window, template, retention,
  annual review, content readiness, and channel length.
- Concurrent claims and limits are serialized; pre-dispatch failures recover;
  definite rejection retries are bounded; post-dispatch ambiguity never
  automatically resends.
- Request builders and the Meta client pass only against loopback fakes with
  synthetic credentials. Exact Graph `v25.0`, redirect denial, body/timeout
  bounds, strict success parsing, and privacy-safe logs pass.
- WhatsApp and Messenger status projection is exact-scope and monotonic.
  Messenger echo-before/after-response, worker/staff race, false-match,
  expiry, and hold-blocking cases pass.
- Deletion, marketing opt-out, and retention reconcile pending, leased,
  authorized, and dispatch-started work transactionally; re-opt-in cannot
  resurrect canceled work; access output excludes seeded outbound evidence.

## Acceptance Mapping

| Acceptance item | Local Phase 5 result | Remaining evidence |
|---|---|---|
| AC-06 human takeover | Exact service-echo correlation and staff-echo fail-safe pause pass | Deployed async worker and approved test-Page race/outage evidence in P7 |
| AC-07 opt-in/out | Exact consent and final send-time recheck pass; opt-out cancels template work | Approved test-asset marketing behavior in P7 |
| AC-23 exactly-once behavior | Durable intent, lease/crash boundary, bounded retry, unknown closure, status monotonicity pass | Live test-provider delivery/restart evidence in P7 |
| AC-24 send-time eligibility | All approved policy races fail closed locally | Deployed worker evidence in P7 |
| AC-25 rate/cost limits | Explicit customizable contact/account/global limits and bounded retries pass | Sanitized alert delivery in P6 and test-asset limits in P7 |

## Negative Claims

This evidence did not use or inspect a live Meta token, call Meta Graph, send a
test-number/Page message, deploy a worker, change a tunnel or public route,
attach a network, use customer data, invoke Manifest/n8n, or touch production
WhatsApp/Page assets. Loopback HTTP behavior does not prove live provider
permissions, version support, delivery, or coexistence.
