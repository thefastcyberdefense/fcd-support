# AGY: observe the unresolved promotion command boundary

Date: 2026-11-04 (Asia/Dhaka).
Purpose: continue the existing held PR #10 with CI-harness-only evidence for the
promotion failure. PR #12 establishes diagnostic behavior and limits, not the
historical validator cause. Codex owns runtime-controller changes, acceptance,
merge and current-server disposition/rollout.

## Start boundary and permitted files

- [ ] Read `../reviews/2026-11-04-pr-12-acceptance.md`, the accepted diagnosis,
      current TODO/context, original review and synthetic fixture policy.
- [ ] Continue `codex/agy-p6-health-transport-stress` in its isolated worktree.
      Fetch its remote head and preserve Codex's `cf9defb` corrections. Merge
      fresh main without discarding source or creating duplicate grants/docs.
      Keep PR #10 draft; do not modify Codex's primary checkout.
- [ ] Scope changes to the synthetic CI harness, evidence allowlists, focused
      tests, a narrowly necessary workflow adjustment and the results document.
      Keep the existing full recovery and both health-stress lanes intact.
- [ ] Do not change production promotion/lifecycle/state scripts, validator
      acceptance, model/provider behavior, runtime configuration or recovery
      authority. If a needed correction lies there, submit a failing
      reproduction and precise proposal for Codex instead of implementing it.

## Work and acceptance criteria

- [ ] Identify the actual host-inspection command boundary under the promotion
      exchange, including its real function and command-substitution context.
      Exercise the extracted real observer and owning source; do not duplicate
      a trap in a test or invent a differently named lifecycle function.
- [ ] Add opt-in, closed CI observations that distinguish a completed command
      from a failed or unobserved command, with a bounded integer exit status
      only when actually observed. Describe a Docker/host-command return as
      such; it does not prove whether a container started or why it refused.
      A numeric return alone must not become an invented internal root cause.
- [ ] Keep observations on the existing dedicated diagnostic descriptor and
      behind the existing synthetic/closed-v1 gates. Output fixed allowlisted
      tokens/counts only. Never emit BASH_COMMAND, command arguments, payloads,
      options, stdout/stderr bodies, environment values or container identifiers.
- [ ] Write behavioral tests first for canonical success, nonzero execution,
      allowlisted diagnostic output, empty/unallowlisted output and unavailable
      transport. Include synthetic sensitive sentinels on both streams and
      verify absence from every published output. Report RED before the change
      and GREEN afterward. Preserve the caller's status and BASH_REMATCH.
- [ ] Verify no false failure from a preceding conditional, no missed event in
      the real subshell, and no change to acknowledgement comparison, journal
      containment or child reaping. Use bounded synthetic ports when an actual
      external process cannot be deterministically failed.
- [ ] Execute at most one real promotion per fresh disposable CI scope in each
      supported fresh/precreated layout. Stop on uncertainty. Never clear or
      retry that scope, infer SQL commit from actor absence or weaken the
      existing cleanup/preservation guards. No global Docker prune is allowed.
- [ ] Preserve the failed observations in runs 41656688444, 41682134296,
      41682171351 and 41778860198 (fresh job 126405652145). Run 41768173765 was
      green; do not cite it as a failure. Keep ordinary one-run health lanes
      separate from ten-iteration stress lanes.
- [ ] Record exact source heads, commands, RED/GREEN, independent counts/skips,
      immutable CI links, closed observed failure stage and remaining unknowns
      in `2026-11-04-antigravity-promotion-observability-results.md`. A passing
      rerun or non-reproduction does not erase a prior failure.
- [ ] Run appropriate full/focused/native checks and explicit changed-Markdown
      formatting, citation/link checks and secret scanning. Commit/push the
      existing draft PR #10 with an accurate title/body and report the result
      to Codex. Do not claim all workflows green from passing stress subjobs.

Acceptance: the actual boundary produces accurate closed evidence without
altering execution or privacy; tests fail for the intended pre-fix behavior;
no uncertainty is retried/cleared; the historical cause is claimed only if
demonstrated. If the full workflow still fails, retain and report its precise
closed outcome for Codex; do not force a pass.

No SSH/shared-server Docker, accounts, DNS/tunnels, daemon/host restart, live
Meta/Manifest/model/n8n/provider traffic, production assets or customer-derived
fixtures are authorized. Deployed dashboard rollout and the held health job
remain Codex-owned and are not resolved by this assignment.
