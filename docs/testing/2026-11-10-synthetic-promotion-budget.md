# Synthetic promotion callback budget alignment

Date: 2026-11-10 (Asia/Dhaka). Integrated base:
`3016959cf31e7f1972cc0e68586a78703b98a904`.

## Measured configuration mismatch

Observer source 1266aa4, runtime 42748498499, records first-challenge readiness
at 4/5 seconds, full snapshots at 7..9 seconds, validator at 9/10 seconds and
final context at 9/10 seconds. Three context checks succeed; precreated stress
129606228369 records context refusal at 10 seconds and an exited actor. The
other failed jobs are 129606228628, 129606228630 and 129606228669. Additional
record/selection checks and the reply still follow that inspector context.
All four lanes pass health, checkpoint and restore, then refuse promotion.

The fixture independently sets the child host-check allowance to 10,000 ms
while `common.env` already gives operations a 20,000 ms call budget. Integer-
second host observations do not directly prove the child's timer firing, but
the old sub-budget leaves effectively no margin for the measured checked reply.

## Selected configuration correction

Derive the synthetic `PROMOTION_HOST_CHECK_TIMEOUT_MS` from the existing
`common.OPS_MAX_CALL_MS`. This increases the synthetic handshake allowance from
10 to 20 seconds while retaining the existing 20-second parent/SQL bound.
Both standard and CI-recovery fixture profiles use the same relationship.
No production parser, operator configuration, transaction bound, comparison,
handshake validation, retry, fallback, replay or settlement logic changes.
The settings remain operator-configurable in the actual application.

Alternatives considered: batching Docker observations may reduce cost while
preserving complete proof, but changes successful production proof code before
its bottleneck is isolated. Increasing the overall call/SQL budget or omitting
proof fields is unnecessary. The selected change uses an already supported
configuration: the production parser accepts equality and rejects a child
host-check allowance exceeding its parent budget.

## Verification and limits

- RED: both fixture profiles expose 10,000 where the parsed common configuration
  supplies 20,000 (2 failed / 6 passed). Existing fixture assertions are retained.
- GREEN: **134 tests / 0 skips** across runtime fixture, promotion command,
  handshake, host validator and host-wrapper suites, **10.50 seconds**.
  The exact unchanged 20,000 ms parent budget is asserted in both profiles.
  Independent deadline, partial-frame, abort, stalled-writer and over-parent
  refusal controls remain in the production test suites.
- Before this test-fixture correction, combined accepted governance plus runtime
  source passes the full local gate: **2,212 passed / 461 platform skips**, 135
  files, **284.23 seconds** (whole command **329.82 seconds**). Phase 0,
  formatting, lint, strict typecheck and build pass. The combined pattern scan
  covers 729 tracked files; production dependency audit reports zero findings.
  These results are attributed to the integrated base, not inferred as a new
  final-source full run after the fixture change.
- Independent static review judged this fixture-only alignment justified and
  low risk, retaining the existing parent bound and failure tests. Final static
  checks and new exact-head CI are recorded before acceptance.

A later passing runtime run would prove the supported 20-second configuration,
not 10-second performance or the precise historical timeout cause. No failed
scope is reused, and no server journal, provider or deployment state is changed.
