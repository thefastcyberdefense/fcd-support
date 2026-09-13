# Phase 4 Model Policy Schema Evidence

Date: 2026-09-13 (Asia/Dhaka)

## Scope

This checkpoint completes approved Phase 4 plan Task 15. It adds only local
PostgreSQL schema and synthetic migration tests. It does not enable inference,
call Manifest or a provider, use live data, change infrastructure, or touch Meta
or production assets.

## Implemented controls

- `model_policy_versions` stores every rate, concurrency, queue, timeout, token,
  cooldown, FAQ, candidate, provider-attempt, and architecture-ceiling value as
  explicit reviewed policy data. Operational columns have no defaults.
- Values use closed safety bounds and relational checks: the 15-minute contact
  value cannot exceed its 24-hour value, contact use cannot exceed global use,
  FAQ ambiguity stays below its match threshold, and approved provider attempts
  cannot exceed the architecture ceiling.
- Policy identity and values are immutable. Append-only review events alone move
  a policy through `draft`, `submitted`, `approved`, `active`, and `retired`;
  event time is monotonic and only one policy can be active.
- `model_usage_windows` stores a policy reference, fixed closed window, bounded
  count, expiry, and either a 64-character pseudonymous contact key or no contact
  key for an aligned UTC global day. It contains no prompt, response, provider,
  or credential field.
- `model_call_leases` provides unique logical-call and source-event keys, internal
  conversation/policy references, a closed queue/active/terminal lifecycle,
  bounded outcome codes, lease expiry, and timestamps. State/expiry indexes
  support bounded cleanup and capacity checks.
- Downgrade refuses while any policy, review, usage, or lease evidence exists;
  an empty migration cleanly rolls down and reapplies.

## Test-first and validation evidence

- Before migration eleven existed, the focused migration suite failed six tests:
  the four tables and policy columns were absent and migration count remained
  ten.
- After implementation, the focused migration suite passed 31 tests, including
  table/column shape, thirteen no-default policy values, prohibited content and
  provider columns, bounds, reviewed transitions, append-only history, invalid
  contact-window shape, populated downgrade refusal, and clean down/reapply.
- `npm run check` passed the Phase 0 validator, formatting, lint, strict type
  checking, build, and 450 unit tests across 36 files.
- The complete guarded PostgreSQL suite passed 319 tests across 23 files,
  including all eleven migrations and prior privacy, retention, deletion,
  takeover, consent, knowledge, learning, reply, and admin behavior.
- `git diff --check` and the changed-file credential-pattern scan passed before
  the checkpoint commit.

All inserted values are conspicuously synthetic policy fixtures. The recommended
balanced values appear only in tests as data and are not database defaults or
application constants.

## Remaining gates

Task 16 must implement typed policy input, role-checked review operations,
effective stricter-source resolution, atomic usage/capacity/cooldown decisions,
closed lease transitions, idempotent content-free escalation, and private
dashboard views. No model path is enabled by this schema alone.
