# Codex: finite promotion stability observations

Date: 2026-11-09 (Asia/Dhaka).
Reviewed AGY documentation source: `e781163adac4f0ccc89dedae42639224f2b0b752`.
This is the actual Git revision; the expanded SHA in the return message does
not resolve. Implementation-head a3c4d0a and documentation-head e781163 CI
outcomes are distinct and retained in the corrected AGY results document.

## Design and authority

The original full canonical source/terminal, target/terminal and before/after
comparisons remain authoritative. No comparison input is filtered, normalized
further, retried or accepted by the new diagnostic path. A mismatch still throws
`promotion_host_invalid` and follows existing uncertain-operation containment.

A refusal can identify one first differing fixed path, such as
`samples.stability.source_terminal.startedAt` or
`samples.stability.before_after.hostBinds`. Paths derive only from schema-owned
property names. Arrays and arbitrary maps are reported at their fixed parent
field; record keys, values, identifiers, filesystem paths and environment values
cannot enter tokens. One first difference is not an exhaustive diff or a
proven historical root cause.

There are 325 finite codes. The validator sanitizes its error code against that
set. Both shell publication ports share a closed path validator, reject arbitrary
suffixes, retain the 128-character bound and preserve opt-in/descriptor-3
publication. The generic stability token remains recognized for history and
fallback. No SQL, job-journal, recovery decision or provider authority changed.

## Test-first evidence and review

- Four observation tests first failed on the generic stability code.
- Four production/CI publication controls first failed because the new paths
  were not recognized; negative privacy controls already refused unknown paths.
- Initial GREEN: 84 tests across promotion host and publication suites.
- Exhaustive parity caught three shorthand schema names omitted from the first
  shell field list. They were added; all 325 producer codes now round-trip
  through both consumers. Unknown/private suffixes refuse.
- The health fixture retains real uncertainty/cancel handlers with fake external
  state/Docker/reporting ports. Fixed counters prove permitted stop, exact actor
  removal, uncertain state and no normal successor/completed marker after refusal.
  The successful control exits at acknowledgement validation; it does not prove
  normal completion cleanup or actual SQL/journal persistence.
- Combined promotion host, publication and health suites: 104 passed / 0 skips,
  exit 0, 4.04 seconds.
- Independent read-only review found no important actionable issue in privacy,
  parity, unchanged full-comparison authority or fixture containment.

## Full local gate

`VITEST_MAX_WORKERS=2 npm run check` exits 0: Phase 0, formatting, lint,
typecheck, unit tests and build all pass. Vitest reports **2,125 passed / 454
skipped**, 134 files, 271.12 seconds, with no failures. This is Windows/local
proof, not shared-server or live-provider testing. Subsequent disposable CI is
recorded with exact source/run provenance in the main review.

A mistaken line-ending command was rejected by automatic approval review before
execution. Read-only verification confirmed all three source files remained
intact. The unnecessary line-ending mutation was abandoned; no source was lost.

No live/shared-server action occurred. PR #10 remains draft pending source
acceptance and complete check disposition. The deployed health hold is preserved.
