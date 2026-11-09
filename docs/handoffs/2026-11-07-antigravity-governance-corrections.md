# AGY assignment: bounded PR #13 corrections and evidence reconciliation

Date: 2026-11-07 (Asia/Dhaka).
Read [Codex's disposition](../reviews/2026-11-07-agy-update-disposition.md).
Continue PR #13 on `codex/agy-ci-and-repo-governance` in an isolated worktree.
Keep PR #13 and PR #10 draft. Do not implement US-101..105 or new runtime
features under this assignment. The submitted audit is input, not approval.

## Checklist and acceptance criteria

- [ ] Merge/rebase fresh synchronized main into the governance branch. Use the
      merge-base PR diff for review. The PR must preserve existing main evidence;
      do not call endpoint-only absences destructive PR deletions.
- [ ] Fix the reproduced two Prettier failures, five trailing-whitespace lines
      and `no-useless-assignment`. Install the locked toolchain without lifecycle
      scripts before reporting full lint/typecheck/build results.
- [ ] Align `AGENTS.md`, workflow names/output and audit documents with actual
      enforcement. Source-text UI/SEO audits must not claim rendered WCAG,
      overflow, viewport or complete SEO verification. Keep future browser
      coverage explicit. Preserve webhook-only public exposure and model fallback.
- [ ] Repair scanner coverage and failure semantics test-first. Include relevant
      tracked documentation/tests, use narrow synthetic exceptions, reject
      unexpected read failures and suppress matched values. Test synthetic
      forbidden matches, safe controls and error paths. State pattern-scanner
      limitations; do not claim it proves provenance or detects every secret.
- [ ] Exercise the PR handoff script with authored event fixtures. Missing,
      blank and placeholder-only required evidence must not stand in for real
      handoff content. Include a valid minimal control and non-PR/missing-event
      skip controls. A skip must be reported as a skip. Do not claim regex
      headings verify linked artifacts, story approval or actual test success.
- [ ] Reconcile audit findings individually with source/test citations. Existing
      outbound `delivery_unknown` persistence and abort handling are controls,
      not wholly missing features. Separate any notification residual gap.
      Mark unverified allegations and product enhancements as such. Do not
      invent evidence, approved story IDs or requirements from other projects.
- [ ] Keep external notification adapters owner-deferred and public trust-center
      work proposed. Proposed policy contacts/SLAs/safe harbor need approved
      provenance before publication as commitments. Preserve current CodeQL
      coverage and accurately describe remaining mutable action references.
- [ ] Supply exact FCD Support ClickUp source links/IDs if available from your
      earlier inspection, or explicitly mark remote evidence unavailable.
      No ClickUp writes/messages or task completion claims are delegated.
- [ ] On the PR #10 branch, update only its results/description to distinguish
      historical 30/70-test counts from corrected 100/140 counts. Record final
      c8304a2 runtime 41860854083: fresh lanes pass, both precreated lanes refuse
      at promotion with `samples.stability`; ten precreated health iterations
      pass. Do not claim this identifies a changed field or the historical cause.
      Preserve failed-scope evidence. Do not rerun or clear an uncertain scope.
- [ ] Run applicable regression suites, Phase 0, formatting, lint, typecheck,
      build and merge-base whitespace checks. Force-format changed Markdown
      using `--ignore-path .gitignore`. Run disposable CI on the final source;
      report every lane and any remaining failure rather than weakening gates.
      Push draft results with exact Git-generated SHAs and command exits.

Deliver a new dated results file listing each checkbox, proof and any unresolved
item. No merge authority is delegated. A green audit scaffold is not permission
to close Phase 7/8 or a runtime incident.

No production-controller, database, acknowledgement/recovery-rule, credential,
SSH, shared-server Docker/systemd, host restart, tunnel/DNS, Meta, Manifest,
n8n/provider, external notification or production-number changes. Codex retains
the actual stability fix, health-job disposition and server deployment.
