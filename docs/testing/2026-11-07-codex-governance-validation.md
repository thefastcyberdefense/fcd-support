# Codex governance review corrections and validation

Date: 2026-11-07 (Asia/Dhaka).
Reviewed PR #13 submission: `14f91c4ba2e72c78e68043d1e32cc603bd5bed19`.
This record accompanies the direct Codex corrections on the same isolated branch.
PR #13 remains draft; this is not runtime or server acceptance.

## Reproduced gaps and direct fixes

The submitted 12 governance tests pass independently. Additional authored
regressions exposed broad marker exemptions and PR payload validation gaps:
15 failures / 14 passes in the initial RED run. The scanner accepted values
containing ordinary internal words such as `test`, even without a synthetic
prefix. Malformed JSON value types could throw or report a non-PR skip. Markdown
formatting could conceal placeholder-only evidence.

- Credential assignment exceptions now require a delimited obvious prefix.
  Recognized provider-token shapes cannot exempt themselves through marker words.
  Matched values remain suppressed. A corrected provider-shaped fixture was also
  checked against the original scanner: all six marker cases fail as expected.
- The event parser validates JSON structure and field types with Zod, returning
  a closed failure for invalid shapes rather than throwing or skipping them.
  Genuine non-PR objects and missing event context still report explicit skips.
- Placeholder detection normalizes common Markdown wrappers, blockquotes and
  ordered lists while preserving substantive original inline command evidence.
  Independent review caught the quoted-placeholder gap and an inline `tsc`
  evidence regression; three RED cases reproduce them, and both are corrected.

The final focused governance suite passes **36 tests / 0 skips**, exit 0,
0.938 seconds. Independent read-only patch review reports both follow-up findings
closed and no additional important regression in the final normalization change.
A final RED case also showed that an inline configuration value alone could
satisfy validation. Generic backtick acceptance was removed in favor of known
command/outcome tokens and generic inline command forms. The inline `tsc`
control remains valid. Independent review also caught valid Docker/make/script
commands rejected by a finite tool list; three RED controls reproduce that issue,
and the final generic command-form check passes them without accepting the
configuration-only control.
The checker remains structural; it cannot prove artifact content, test execution
or approval, and the scanner cannot prove fixture provenance or detect every secret.

## Broader Windows execution

A broader `VITEST_MAX_WORKERS=4 npm run check` during review exits 1:
**2,000 passed / 446 skipped / 3 failed**, 133 files, 355.25 seconds.
The failures are the unchanged 5,000 ms timeout cases:

- `tests/backup-harness-containment.test.ts`: read-only initializer containment.
- The same suite: exact-ID failed-initializer cleanup before volume removal.
- `tests/operations-promotion-controller.test.ts`: lost PostgreSQL create acknowledgement.

This is not a full passing gate. The final Markdown follow-up changes were
validated separately with the 32-test governance suite; do not attribute the
broader run to an immutable final source. No timeout or containment rule was
weakened. A separate fresh-fixture one-worker check passes **77 tests / 0
skips**, three files, exit 0, 126.85 seconds:

```text
VITEST_MAX_WORKERS=1 npx vitest run tests/governance-scripts.test.ts tests/backup-harness-containment.test.ts tests/operations-promotion-controller.test.ts --reporter=dot
```

This isolates the previously timed-out suites and includes the then-current
32 governance cases; the final token-predicate follow-up passes 36 governance
cases separately. This it does not retroactively turn the broader run into a passing full gate.

## Final-source validation and CI boundary

Phase 0, formatting, lint, typecheck, build, explicit changed-Markdown formatting,
scanner and whitespace checks are required before publication. Exact command
outcomes and the resulting source revision are recorded in the main review.
Historical AGY results remain attributed to their original source revisions.

The submitted code head 05df7a4 has seven green workflows, but its documentation
head 14f91c4 runtime 42384678769 fails fresh health with an empty acknowledgement
(job 128439452060); precreated runtime passes. PR #10 documentation head d5fbb9b
runtime 42381386563 has three promotion stability refusals. These failures are
not resolved by this governance patch or by an earlier green workflow.

No SSH, shared-server Docker/systemd, tunnel, provider, account or ClickUp action
occurred. The uncertain server health job is preserved; no completion inference,
retry, clearing or managed dashboard deployment is authorized by this record.
