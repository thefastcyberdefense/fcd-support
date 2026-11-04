# PR #12 promotion diagnosis review

Date: 2026-11-04 (Asia/Dhaka).
Reviewed head: `6c466856cd8c3a56e64b757615cb8a6e9a2185ba`.
Base: `3685ae0de131e218d1eb946dd60d726aa43f3706`.
Decision: **Keep draft; evidence and reproduction corrections required.**

The collected failed promotion observations are useful. They consistently keep
the uncertain job/selection contained, and later passing runs do not erase
those failures. The PR makes no production controller change. All four
submitted-head workflows are green, but that does not establish the claimed
historical cause.

## Required corrections

1. **Distinguish observability from cause.** The document's statement that it
   identifies the exact root cause is unsupported. A nonzero host-inspection
   boundary plus discarded stderr does not explain why the validator failed.
   Missing modules, file permissions and Docker constraints are hypotheses,
   not demonstrated causes. Do not infer empty stdout or early failure from
   previous-status traces alone. Quote the actual diagnostic implementation
   accurately and leave the historical underlying cause unresolved.
2. **Exercise the claimed boundary.** The new test replaces both
   operations_execute_job and operations_inspect_promotion_host with test-written
   failure/journal behavior. It therefore does not reproduce the real validator
   transport, stderr suppression or durable lifecycle. Preserve any useful
   controller-exit assertion with an honest simulation label, and replace the
   self-written journal/next-attempt proof with actual owning-source tests.
   Existing lifecycle/promotion tests may be reused rather than duplicated.
3. **Keep diagnostics closed.** The proposed publication of captured raw
   Node/Docker stderr conflicts with the evidence policy. Propose bounded,
   allowlisted execution/parse/exit classes and counts. A raw error message,
   SQL row, environment field or customer-derived string must never become CI
   output. Retain fail-closed acknowledgement and uncertainty rules.

The correction must distinguish actual historical CI evidence, a newly injected
synthetic failure and a proposed observability improvement. A deterministic
simulation does not identify the historical validator's failure condition.
No new resolver, blind rerun, journal clearing or shared-server action follows
from acceptance of this evidence-only package.

AGY follow-up: `../handoffs/2026-11-04-antigravity-promotion-diagnosis-corrections.md`.
Codex retains any production runtime correction, current health-job disposition
and server rollout. Dashboard and health source fixes are reviewed separately;
this evidence-only draft does not block acceptance of independently verified
PRs #9–#11.
