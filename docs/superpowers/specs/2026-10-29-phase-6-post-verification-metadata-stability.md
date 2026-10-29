# Phase 6 post-verification metadata stability

The initial correction is merged as `70f8e7073d20bce0b54d84011e001a2bd5bb527f`
with four passing exact-source workflows. It fixes the live host collector and
unordered host-bind inventory. The later PostgreSQL stop/remove guard still
compares raw mount-array order in `scripts/operations-promotion-controller.sh`.

`OPERATIONS_PROMOTION_STATIC_FORMAT` includes complete raw JSON `.Mounts`.
Capture stores that projection; every subsequent running/exited proof compares
it byte-for-byte. A read-only probe used this exact unchanged template against
both preserved synthetic PostgreSQL actors: ten reads each produced two adjacent
raw changes each. All complete metadata matched after sorting complete mount
records, retaining every field and duplicate entry. A deterministic full-record
reversal also failed raw equality while preserving the same metadata. State
hashes stayed unchanged. This controller file is identical at `6faff8b` and
`70f8e70`, so the defect remains in the merged source.

This is an independent later blocker, not the recovered cause of the removed
job. Preserve all uncertain scopes. Do not execute the unadmitted `70f8e70`
proposal. Require a reviewed correction and its exact-source CI, then repin the
fresh action and observer before any new server mutation.

## Comparison choice

Codex recommends one atomic multiline projection: an ordered header containing
**every existing non-mount field**, followed by each **complete raw mount JSON
record** on a separate line. One fresh Docker inspect still supplies the whole
observation. Compare the header exactly; sort only complete mount-record lines
through the existing trusted host `LC_ALL=C sort` port. Preserve every line and
its multiplicity, bound input and refuse unexpected/empty framing. Docker JSON
encoding escapes embedded newlines. Never use sort-unique or drop fields.

This keeps the original complete opaque-record comparison without adding a
runtime or privileged helper. Full raw records include Mode and Driver, which
the six-field live-host projection omits. Mapping through that narrower
projection would weaken the existing guard.

The alternative is a dedicated compiled strict TypeScript static-metadata codec
that retains every raw field/observation and normalizes only mount order. It
provides explicit types but adds a validation interface/transport. Use it if
the smaller existing port cannot preserve the full contract; document the call.

The owner delegated routine decisions. This correction adds no authority,
exposure or business-policy change. Retain all actor/image/volume/network and
physical-identity checks, source freeze/challenges, protected journals,
stop/exit checks and write-aware selection rules. Commands and entrypoints
remain ordered. Keep every current fresh observation.

## Acceptance

- Deterministic mount permutations pass capture and every running/exited proof.
- Changed source, destination, name, type, RW, propagation, Mode, Driver,
  extra/missing entries, duplicate count and unknown added raw fields still
  refuse before the next destructive action. No silently dropped fields.
- All ordered header metadata remains exact. No ignored errors, cached
  postconditions, timeout increases, global sorting or permissive fallback.
- A scoped actual-Docker test invokes production comparison with deliberate
  full-record permutation and negative controls; random variation is not needed.
- Relevant focused/native, full local and PostgreSQL gates pass with exact
  counts/skips and owned cleanup. Updated exact-source CI precedes any fresh
  server action. Task 11/Task 15/P6-GATE remain open.
