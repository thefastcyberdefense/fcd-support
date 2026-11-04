# AGY: repair observer classification before interpreting promotion output

Read `../reviews/2026-11-04-pr-10-observability-review.md` and the original
observability assignment. Continue the existing isolated PR #10 branch; keep
it draft and preserve Codex's earlier health corrections. The allowed scope
remains CI harness/evidence/tests/results only. No production-controller,
acknowledgement, recovery-rule or server changes are delegated.

- [ ] First add RED parity tests against the actual production diagnostic
      function for its accepted fixed fields, including the five omitted ones.
      Align the synthetic consumer without broadening it to arbitrary text or
      field values. GREEN must expose each recognized closed token unchanged.
- [ ] Replace false success/cause labels. Empty or unexpected output with exit
      zero is not canonical. Either verify the trusted expected bound or report
      neutral observed exit/output categories. Status 125–127 alone must not
      establish a transport/internal cause. Preserve safe historical parsing
      where necessary and describe old observations under their original rules.
- [ ] Add malformed-number cases before fixing both validators: huge decimal,
      leading zero, negative, empty/nondecimal and values above 255. Enforce
      lexical limits before arithmetic; verify 0 and 255 controls. Published
      suffixes must remain canonical integers in 0..255.
- [ ] Source the real operations_inspect_promotion_host with synthetic external
      ports and the extracted real TRACE. Reuse or factor the PR #12 fixture;
      do not write another replacement inspected function. Cover all required
      success/failure/output/gate/status/capture cases and both-stream sentinels
      through this boundary. Keep no-write/local fixtures bounded and cleaned.
- [ ] Generate full provenance with git rev-parse/cat-file. Correct the three
      invented expanded hashes and remove unsupported stdout conclusions.
- [ ] Record the final-head 41851012111 health-9 empty-acknowledgement failure
      separately from later promotion failures and earlier passing stress runs.
      Preserve uncertainty; never replay that failed scope or infer SQL commit.
- [ ] Rerun focused/full applicable tests and disposable fresh/precreated CI
      once per fresh scope. Corrected diagnostics may reveal an already known
      closed field; record what is actually observed without claiming a root
      cause until demonstrated. Do not weaken validation to obtain a green run.
- [ ] Force-format changed Markdown with --ignore-path .gitignore, validate
      Phase 0, citations/links, whitespace and secret patterns. Update the
      results document with exact final source/run/lane outcomes and RED/GREEN.
      Commit/push the existing draft PR for Codex review.

Acceptance: recognized producer output is recognized by the consumer, categories
claim only measured facts, numeric publication bounds hold without overflow,
and actual owning-source tests protect those properties. Report any remaining
runtime failure precisely; a passing subjob cannot stand in for the workflow.

No SSH/shared-server Docker, host/daemon restart, credentials, raw logs, live
Meta/Manifest/model/n8n/provider calls, global cleanup, journal resolver or
production action. Codex owns the underlying runtime fix and deployed health
job disposition; this checklist does not authorize either.
