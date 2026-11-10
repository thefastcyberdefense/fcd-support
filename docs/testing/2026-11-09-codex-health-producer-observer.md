# Closed health producer observation

Date: 2026-11-09 (Asia/Dhaka). Base:
`94c03d62029a6bdc606f72fb81967af685ee8571`.

Runtime run 42645223225 completed with all four lanes refusing health-1 and
`synthetic_health_ack_diagnostic=empty`. The source remains draft/unaccepted.
This observer distinguishes whether canonical producer stdout exists in daemon
logs when the attached acknowledgement is empty. It does not resolve the cause.

Only the synthetic `closed-v1` DEBUG trace invokes the observer, at the actual
health validator after existing actor/exit checks and only for empty attached
output. It makes one bounded read-only daemon-log observation. NUL, full bound,
read failure or unsupported output produces a fixed category; no bodies, IDs,
arguments or secret values are published. Inactive diagnostics do no probe.

The result never enters lifecycle acknowledgement. Canonical daemon output
still leaves the operation uncertain, with one actor start, permitted owned
containment, no successor/completion and no fallback or replay. Nonempty malformed
attached output does not trigger the observer. Existing no-daemon-read assertions
are narrowed only for this explicit opt-in, empty-output diagnostic; all refusal
and no-success assertions remain.

RED: the new actual-TRACE control failed before observation existed. GREEN:
166 tests / 0 skips across health transport and synthetic evidence in 18.78
seconds. The fixture uses the actual strict shell options. Controls include
producer success with attached failure, private sentinels, over-bound bodies,
nonzero reads and inactive-mode zero observations. Independent read-only review
found no important actionable privacy, authority or lifecycle issue. Phase 0,
formatting, lint, strict typecheck, build and whitespace results are verified
before publication. The 2,152-test full gate belongs to prior 94c03d6; no new
full-gate count is inferred from these focused checks.

No shared-server action, provider traffic or uncertainty settlement occurred.
