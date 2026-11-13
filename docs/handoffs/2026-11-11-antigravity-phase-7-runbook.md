# AGY: current-runtime Phase 7 test runbook

Date: 2026-11-11 (Asia/Dhaka). Documentation-only consolidation of the existing
approved Phase 7 acceptance scope. Codex owns source acceptance, shared-server
incident disposition and external execution. Start a fresh isolated
`codex/agy-phase-7-current-runbook` branch from freshly synchronized main;
record the exact SHA and preserve every other checkout/worktree.

Read AGENTS.md, PLAN/TODO/PROJECT_CONTEXT, SYNTHETIC_FIXTURE_POLICY,
`docs/testing/acceptance-matrix.md`, `docs/testing/phase-7-readiness.md`, the
current server incident and latest Codex review. Historical integration at
207a5e6 does not prove the current runtime is connected. Current private admin
is unhealthy, and the health/uncertain journal remains held. PRs 18 and 19
are accepted as merges f6ca679 and 2e24997 after Codex corrections and final-head
CI. Verify fresh main contains both merges; those tests do not settle the server
incident or prove current live integration.

## Deliverable and boundaries

Create `docs/operations/phase-7-current-runtime-test-runbook.md` and a dated
results record. Map existing implemented commands/tests and missing manual proof
into one executable operator sequence. This grants no live execution, new
product feature, production script, dependency, CI-policy or public route change.
No SSH, Docker daemon, account login, credential inspection, Meta/Manifest API,
tunnel/DNS, n8n, ClickUp, provider, message or server action is delegated.
Public official documentation may be read to verify external procedure details.

## Checklist and acceptance criteria

- [ ] Record exact source/tracker references and distinguish historical external
      evidence, current local/CI proof and missing current live proof for every
      required acceptance item. Do not mark any gate PASS or close tracker rows.
- [ ] Start with a fail-closed readiness checklist: accepted/pinned deployment,
      known connected callback target, healthy private dashboard/roles, settled
      prerequisites without replaying uncertain jobs, test-only Meta assets,
      current Graph API pin, appropriate test-recipient access, approved published
      synthetic facts, active reviewed limits/policy, disabled Manifest body
      recording attestation, tool isolation/redaction and private connectivity.
      A missing prerequisite must stop its dependent test without inventing proof.
- [ ] Separate incoming delivery, durable receipt, decision, provider acceptance,
      actual device/customer-side delivery, status processing and human-echo
      application. A synthetic signed HTTP probe is not physical-device proof;
      a received Page echo is not evidence that the outbound pause was applied.
- [ ] Give an ordered test sequence for Messenger and WhatsApp test assets:
      received message and eligible reply; English/Bangla FAQ; model fallback;
      human pause/resume; duplicate/stale/out-of-order handling; consent/opt-out;
      reviewed deletion/retention; configurable limits/provider outage; and
      isolated backup/restore plus service/tunnel/restart scenarios. Use actual
      existing command entrypoints only; source-check every command and flag.
      Mark any missing helper/runbook as a gap rather than inventing a working CLI.
- [ ] For each test state owner, required authorization, prerequisites, authored
      synthetic input, expected visible result, minimum content-free database or
      application proof, failure stop condition and rollback/manual coverage.
      Keep customer text, credentials, phone-number IDs, account IDs, cookies,
      model prompts/outputs and raw webhook/provider payloads out of artifacts.
- [ ] Include the seven existing private sidebar modules and each authorized
      role's expected behavior, login/MFA/session/origin/CSRF controls, empty and
      populated synthetic states, and meaningful reviewer actions. Distinguish
      operator browser execution still needed from source-text UI/SEO scaffolds.
      Do not propose a public dashboard, Trust Center or new CRM/inbox module.
- [ ] Preserve the shared-host boundary explicitly: no full-host reboot, daemon
      restart, network prune or unrelated-project disruption. Outage/restart
      drills must have exact scoped plans and separate operational coordination;
      documentation alone never authorizes execution. Preserve the connected
      older Meta test webhook until an approved switch is verified.
- [ ] Reconcile version/policy contradictions with exact current source and
      primary official references. In particular, retain the current configured
      Graph API pin; historical v26 evidence does not authorize a version bump.
      No live probing or new provider/fallback policy is delegated.
- [ ] Force-format changed Markdown, validate Phase 0, verify every repository
      link/command citation, run fixture/secret pattern and whitespace checks,
      and submit a separate draft PR with Summary, Validation, Evidence, Scope
      and Rollback. Include exact head/CI links and honestly label unexecuted
      commands. Do not merge, deploy, launch or treat this as production approval.

A useful result lets Codex/operator execute approved tests with clear stop
conditions after the server is ready. It does not manufacture missing live
proof, change the release scope or settle the existing health incident.
