# Phase 0 Gate Validation

Finding title: Phase 0 gate could be label-only or over-authorize later actions

Candidate ID: `P0-GATE-VALIDATION`

Instance key: `phase-0-planning-gate`

Ledger row: `P0-GATE`

Disposition: **suppressed** — the candidate does not survive current repository
validation.

Confidence: high (focused executable negative controls, full repository checks,
and static evidence tracing)

Validated: 2026-08-27 (Asia/Dhaka)

## Validation Method

The validation used the real repository gate artifacts through
`scripts/validate-phase0-gate.ts`. The validator treats the tracker and policy
as inputs, the planning authorization as the protected sink, and the following
controls as required preconditions:

- every `P0-003` through `P0-018` row and `P0-GATE` is `COMPLETE`;
- every repository evidence path referenced by those rows exists;
- the threat model, acceptance matrix, and gate review contain their required
  review sections;
- every production-launch gate parsed from `AGENTS.md` appears in the acceptance
  matrix;
- the gate declares `Authority scope: planning_only` and
  `Production action authorization: false`; and
- every source citation in the threat model and acceptance matrix resolves to an
  existing file and in-range line.

The focused test suite pressure-tests those controls with isolated copies of the
real repository documents. It mutates one control per case and requires the
validator to fail with the corresponding bounded reason.

## Rubric

- [x] All Phase 0 dependencies are complete and reference existing evidence.
- [x] Threat, acceptance, and review artifacts contain the required coverage.
- [x] All ten `AGENTS.md` production-launch gates map into the acceptance matrix.
- [x] The planning gate cannot claim production-action authority.
- [x] Static citations, focused negative controls, and the full repository check
  support the result without secrets or customer data.

## Evidence Observed

- Tracker closure is enforced at `scripts/validate-phase0-gate.ts:54` and
  `scripts/validate-phase0-gate.ts:145`.
- Tracker evidence paths are checked at
  `scripts/validate-phase0-gate.ts:156`.
- Required artifact sections are declared at
  `scripts/validate-phase0-gate.ts:26`.
- Launch gates are parsed from repository policy at
  `scripts/validate-phase0-gate.ts:105`.
- Planning-only authority is enforced at
  `scripts/validate-phase0-gate.ts:224`.
- Source citations are checked at
  `scripts/validate-phase0-gate.ts:116`.
- Negative controls begin at `tests/phase0-gate-validator.test.ts:56` and cover
  missing artifacts/paths, missing sections/mappings, excess authority, and
  invalid citation ranges through `tests/phase0-gate-validator.test.ts:158`.
- The source tracker records P0-017, P0-018, and P0-GATE complete at
  `docs/TODO.md:47`, `docs/TODO.md:48`, and `docs/TODO.md:49`.

## Source, Control, Sink, And Boundary

| Element | Assessment |
|---|---|
| Source | Project-owner request and tracker status/evidence changes that can claim Phase 0 completion |
| Closest control | Executable gate validator plus its negative-control tests |
| Sink | Authorization to proceed with Phase 1 planning |
| Reachable path | `docs/TODO.md` Phase 0 rows → evidence artifacts → `docs/reviews/phase-0-gate.md` decision |
| Boundary | Planning authorization only; external and production actions remain separate approval boundaries |
| Counterevidence | Structured `planning_only`/`false` authority fields, later-gate blockers, parsed policy-gate coverage, and failing mutation cases |
| Proof gaps | Historical external inventory was not re-queried; this validator proves repository gate integrity, not current Meta, Cloudflare, Manifest, n8n, or server readiness |

## What Was Tested

The focused suite confirms the validator rejects:

1. a `P0-018` status changed from `COMPLETE` to `PENDING`;
2. a missing required threat-model artifact;
3. a missing evidence path referenced by a Phase 0 tracker row;
4. a missing required threat-model section;
5. an omitted `model-fallback` launch-gate mapping;
6. `Production action authorization: true`; and
7. a source citation beyond the referenced file's line count.

It also confirms the unchanged repository gate passes, including normalized
hyphen/slash variations such as `backup-restore` and `Backup/restore`.

## Remaining Uncertainty And Next Step

This validation does not re-run read-only external inventories or live test
assets, and it does not convert `PARTIAL`, `PLANNED`, or `BLOCKED` acceptance
rows into passes. Those states remain bound to P3 through P8 and production
promotion gates.

Minimal next step: keep `npm run validate:phase0` inside `npm run check` and run
the standard check after every policy, tracker, threat, acceptance, or gate
change. The next unblocked implementation row remains `P3-005`.

## Validation Closure Table

| Ledger row | Instance key | Root control | Entrypoint/source | Sink/control | Disposition | Counterevidence or proof gap | Survives |
|---|---|---|---|---|---|---|---|
| P0-GATE | phase-0-planning-gate | `scripts/validate-phase0-gate.ts:145` | Phase 0 tracker/evidence update | Planning authorization guarded by evidence, policy mapping, citation, and authority checks | suppressed | Negative controls pass; only historical external-state freshness remains outside this repository gate | no |
