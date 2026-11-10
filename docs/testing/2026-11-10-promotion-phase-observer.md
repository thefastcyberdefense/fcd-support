# Closed promotion phase observations

Date: 2026-11-10 (Asia/Dhaka). Base source:
`4b38c94b943bf30d6cec3a188c84b6926f842198`.

## Final duplex-source CI

Runtime run 42743828614 proves health transport progress: both stress lanes
finish ten health iterations, checkpoint and restore; ordinary fresh finishes
the full recovery/cleanup path (job 129591065083). Stress precreated
129591064819, stress fresh 129591065215 and ordinary precreated 129591065307
refuse promotion with `synthetic_promotion_cmd_diagnostic=canonical_success`.
Their promotion-stage durations are 28.79, 32.61 and 32.87 seconds respectively,
measured from the restore-passed marker to promotion failure. These are whole
stages, not callback timings or proof of an internal timeout. No failed scope
was replayed. CI 42743828586, CodeQL 42743828659 and PostgreSQL/native
42743828604 all succeed; the overall runtime gate remains red.

Canonical validator output does not prove the later running-context check or
challenge reply succeeded. The fixture configures a 10-second child host-check
timer and a separate 20-second operations call budget, while host readiness and
both full snapshots precede the reply. A deadline race is plausible, unproven.
No limit, transaction timeout or validation predicate is changed by this patch.

## Added evidence boundary

Only the synthetic `closed-v1` DEBUG observer emits the new diagnostics. It
records challenge sequence 1 or 2; phase ready, before, after, validator or
context; shell status 0..255; and cumulative host-observed elapsed seconds
0..3600. The clock starts at the host callback after challenge validation.
These coarse monotonic observations include instrumentation overhead and do
not directly measure the child's timer or prove its firing reason.

The host-shell depth latch excludes nested command substitutions. Each phase
is reported once per callback, keeping ten possible phase entries plus the
existing closed markers inside the sixteen-diagnostic publication cap. Actor
state classification reuses the already observed bounded identity string on a
running-identity refusal; only fixed state words are published. There are no
additional Docker, SQL, filesystem-state, network or provider calls. No body,
identifier, nonce, command, path or secret value is emitted. Inactive mode,
unknown fields, malformed bounds and extra fields are suppressed.

## Verification

Two actual-wrapper phase controls failed before implementation. An exact-once
control then caught duplicate validator observations from a nested shell; the
host-depth latch fixes that defect. Four focused suites now pass **205 tests /
0 skips** in **26.33 seconds**. Coverage includes actual host/context refusal,
both accepted challenge clocks through the real promotion exchange, lexical
bounds, inactive mode, sentinel suppression and caller-status/regex-capture
preservation. The existing callback refusals remain refusals; diagnostics do
not authorize success, replay, fallback or journal settlement.

Independent static review found no important privacy, authority, status or
phase-fidelity issue and explicitly retained the timing limitations above.
Static gates and whitespace checks pass before publication; this focused
observer verification does not claim a new full 2,158-test result. That full
gate belongs to the preceding duplex source. No shared-server or live-provider
action occurred. Fresh immutable CI will supply the phase observations.
