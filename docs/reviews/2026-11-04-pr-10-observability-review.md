# PR #10 observability review

Date: 2026-11-04 (Asia/Dhaka).
Reviewed head: `101f684a46f14fb488a29f77c83051044f4269e0`.
Implementation head: `cb6985e80a6c1c3cb2bd7bf75caa7cff414586a2` (resolved from Git;
the submitted expanded implementation reference does not resolve).
Decision: **Corrections required; retain draft/unmerged.**

The observer remains in the synthetic CI harness. Its real trace binding and
subshell-depth latch appear sound; no production-controller change, raw-output
publication or uncertainty replay was introduced. Independent focused execution
passed **70 tests**, four files, 8.75 seconds. Those passing tests do not cover
the classification defects reproduced below.

## Required corrections

1. **Align producer and observer allowlists.** Production
   operations_promotion_host_diagnostic accepts samples.systemIdentifier,
   samples.reference, samples.projectActors, samples.stability and samples.target.
   The generic synthetic publication filter omits them. Codex and independent
   review reproduced all five accepted tokens becoming unallowlisted_output:1.
   Therefore that observation does not establish malformed stdout or absence of
   a production-approved diagnostic; it means rejection by this narrower filter.
2. **Classify only observed facts.** Exit 0 currently becomes canonical_success
   with empty or arbitrary output. Compare the expected bound if claiming
   canonical success, or use a neutral zero-exit label. Codes 125–127 alone
   cannot prove a particular transport/internal failure. Retain the observed
   command status without asserting a cause that was not measured.
3. **Exercise the actual owning function.** The new trace test extracts TRACE
   but writes a replacement operations_inspect_promotion_host. Run the extracted
   observer with the actual sourced host function and synthetic external ports,
   as the accepted PR #12 fixture does. Cover success, recognized diagnostics,
   empty/unexpected output, failed transport, sentinels and status/capture
   preservation through that boundary, not only helper calls.
4. **Bound numbers lexically before arithmetic.** The authored test value
   18446744073709551616 wraps in Bash arithmetic: the helper calls it canonical
   success and the publisher accepts empty_output with that out-of-range suffix.
   Enforce canonical decimal length/range before numeric evaluation in both
   entrypoints. Actual shell statuses are bounded, but the publication validator
   must also reject malformed lines supplied to it.
5. **Correct evidence and provenance.** The result document invents expanded
   hashes for cf9defb, 443d05b and a3b9b08. Actual Git values are:
   cf9defb8f08a3ad6052267f5161eb616d18ab718,
   443d05b94dcffcafa17dea98fe6b6443fb5d8006 and
   a3b9b085956b5f287cafecfc4fa3cf18612ec280. Generate references from Git rather
   than expanding abbreviations manually. Revise the stdout interpretation,
   distinguish implementation-head runs from final-head runs and force-format
   the Markdown; its explicit Prettier check currently fails.

## Final-head CI evidence

Final publication head 101f684 has successful
[CI 41851012880](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41851012880),
[CodeQL 41851012231](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41851012231)
and [PostgreSQL/native 41851012484](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41851012484).
The full [runtime workflow 41851012111](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41851012111)
fails:

- Fresh private-runtime job 126646994126: health/checkpoint/restore pass, then
  promotion refuses with uncertain job/selection and unallowlisted_output:1.
- Fresh health-stress job 126646993818: eight iterations pass; health-9 refuses
  with an uncertain health job, ready selection and empty acknowledgement.
- Precreated health-stress job 126646994093: all ten health iterations pass,
  then promotion refuses with uncertain job/selection and the same observer token.
- Precreated private-runtime passes.

These are distinct outcomes from the older implementation-head run 41848310893.
Do not label final-head stress lanes green using earlier evidence. The new
health-9 failure supplies a concrete disposable-CI observation of an empty
acknowledgement. It does not prove the same cause as the held server health job.
No failed scope was rerun, cleared or treated as proof of SQL completion.

Next correction checklist:
`../handoffs/2026-11-04-antigravity-observer-classification-corrections.md`.
Codex retains runtime investigation and server disposition. No server command,
live provider action or source acceptance/merge occurred in this review.
