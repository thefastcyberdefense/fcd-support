# PR #13: direct Codex corrections and final-head disposition

Date: 2026-11-07 (Asia/Dhaka).
Main baseline: `16678546ec9ae6305ba750016da5b1ba604cf9ac`.
AGY submission: `14f91c4ba2e72c78e68043d1e32cc603bd5bed19`.
Direct correction head: `f0c27ad700450da73346d2283826303930b50ac0`.
PR #10 documentation head: `d5fbb9b10fabb7c834f0328b5d921d3386c55a50`.

Decision: **Both PRs remain draft and unmerged.** Direct corrections are pushed
to the existing PR #13 branch; no runtime acceptance or server rollout is claimed.

## Changes verified and completed

AGY corrected the policy/scaffold distinction, restored main evidence, documented
the model/public-route boundaries and proposed-policy status, reconciled existing
outbound safeguards, expanded scanner coverage and added event fixtures. Its
submitted 12-test governance suite passes independently. PR #10's documentation
delta changes only its results file; the corrected observer source is unchanged.

Codex reproduced and directly fixed the remaining bounded defects:

- Synthetic-marker exemptions matched ordinary internal substrings instead of
  requiring obvious delimited prefixes. Provider-shaped tokens also bypassed
  detection when containing marker words. Prefix matching is now bounded and
  recognized provider tokens do not self-exempt.
- The event parser cast arbitrary JSON to an interface. Null/scalar/array events
  could throw or be skipped; non-string bodies could throw. Zod now validates
  event structure and field types before the documented non-PR skip.
- Formatting wrappers could turn placeholders into apparently substantive
  evidence. Inline configuration values also falsely satisfied concrete
  validation, while a finite tool list could reject valid command evidence.
  Generic command forms now preserve Docker/make/script controls without
  accepting configuration-only text. Common Markdown wrappers, blockquotes and ordered lists are checked
  without losing valid original inline command evidence.

Initial added regressions produced 15 failures / 14 passes. A corrected
provider-shaped fixture was also checked against the original scanner: six
expected failures. Independent patch review found quoted-placeholder and inline
command normalization gaps; three additional RED cases reproduced them. Final
governance suite: **36 passed / 0 skips**, exit 0, 0.938 seconds. The reviewer
confirmed both follow-up findings closed with no additional important regression.

## Exact local validation boundary

Execution used the isolated PR #13 worktree and authored synthetic fixtures:

| Check                                                                             | Outcome                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Phase 0, default formatting, lint, typecheck and build                            | Each exit 0 on final code                                                |
| Explicit changed Markdown formatting                                              | Exit 0; new Codex evidence also force-formatted and checked              |
| Staged security/fixture pattern scan                                              | Exit 0; 712 tracked candidate files; matched values suppressed           |
| Staged whitespace check                                                           | Exit 0                                                                   |
| Focused one-worker governance, backup containment and promotion controller suites | 77 passed / 0 skips, 3 files, exit 0, 126.85 seconds                     |
| Broader four-worker check during review                                           | Exit 1; 2,000 passed / 446 skipped / 3 failed, 133 files, 355.25 seconds |

The broader failures were unchanged 5,000 ms timeout cases in two backup
containment tests and one lost-create-acknowledgement promotion test. All three
pass in the separate fresh-fixture focused execution. No timeout was increased
and no containment assertion was removed. The 77-test focused run included the then-current 32 governance cases. The
final command-token follow-up passes all 36 governance cases separately.
The broader run occurred during review before the final Markdown follow-up; it is not a full passing final-source gate.
See the source-associated record
[`2026-11-07-codex-governance-validation.md`](https://github.com/thefastcyberdefense/fcd-support/blob/f0c27ad700450da73346d2283826303930b50ac0/docs/testing/2026-11-07-codex-governance-validation.md).

## CI outcomes must remain source-specific

GitHub independently confirms all seven workflows succeeded on AGY's code head
`05df7a45182106eaf245093b09059f375fd75fb8`. Its later documentation head 14f91c4
does not have the same runtime outcome:

- [Runtime 42384678769](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42384678769),
  fresh job 128439452060: deploy, verify, private HTTP, maintenance and backup
  pass; health fails with `operations_schedule_failed` and
  `synthetic_health_ack_diagnostic=empty`. Precreated job 128439452358 passes.
- [PR #10 runtime 42381386563](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42381386563),
  d5fbb9b: jobs 128429544768, 128429544783 and 128429544791 fail promotion with
  `runtime_host_diagnostic=samples.stability`. Both stress jobs finish ten health
  iterations. Ordinary fresh job 128429544597 passes.

These observations do not establish one common cause, identify a changed
stability field, or settle any deployed operation. The direct correction head
f0c27ad triggered new checks, including
[CI 42387278593](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42387278593),
[quality 42387278649](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42387278649)
and [runtime 42387278685](https://github.com/thefastcyberdefense/fcd-support/actions/runs/42387278685).
They were queued or in progress at this publication checkpoint; no final success is
claimed and no merge was attempted.

## Ownership and next bounded task

AGY can execute the
[health acknowledgement localization checklist](../handoffs/2026-11-07-antigravity-health-ack-localization.md)
in disposable CI. It delegates harness evidence and tests, not runtime fixes or
recovery authority. Codex retains promotion stability diagnosis, actual health
transport correction, deployed uncertain-job disposition and managed dashboard
rollout. ClickUp records and external assets were not changed.

No SSH, shared-server Docker/systemd, tunnel, Meta, Manifest/model, n8n/provider,
credential or production-number action occurred. Uncertain scopes remain
preserved; no retry, completion inference, journal clearing or server deployment
was performed.
