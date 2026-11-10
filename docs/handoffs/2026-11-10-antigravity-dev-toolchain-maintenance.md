# AGY: compatible development-tool maintenance

Date: 2026-11-10 (Asia/Dhaka). Independent bounded repository maintenance,
following the Windows harness and real health stdio assignments. This can run
in a separate worker/worktree without touching Codex's active runtime branch.

Start from freshly fetched accepted main in a new
`codex/agy-dev-toolchain-maintenance` branch/worktree. Record the exact base SHA.
Read AGENTS.md, PLAN/TODO/PROJECT_CONTEXT, SECURITY.md and the synthetic policy.
PR #13 governance is accepted as merge 6091621; PR #10 runtime correction is
accepted as merge d4cfddd. Primary and other AGY worktrees stay untouched.

## Goal and boundaries

Evaluate a compatible pinned refresh of the development lint/parser toolchain.
Current tracked pins are ESLint 10.8.0 and typescript-eslint 8.65.0. Use official
npm registry/maintainer metadata to establish current compatible releases,
engine requirements and dependency ranges before changing a version. This is
not authority to implement product stories, new runtime behavior or deployment.

## Checklist and acceptance criteria

- [ ] Record Git/npm/Node provenance and official source links for proposed
      versions. Preserve the Node 24 engine line, npm pin and strict lint/type
      semantics. Prefer compatible current-major updates. If a toolchain major
      change is required, stop that dependent change and return a concrete plan.
- [ ] Map the actual dependency graph before/after. Retain exact production
      versions and the approved scoped node-pg-migrate/glob/minimatch overrides.
      Verify the resolved production graph remains equivalent, including nested
      paths needed for patched runtime resolution and `--omit=dev` pruning.
- [ ] Keep edits to necessary development pins, lockfile and dated factual
      evidence. No broad `npm audit fix --force`, global transitive major
      override, unsupported downgrade or incidental production refresh.
- [ ] If no compatible parent release exists, report that exact upstream/range
      constraint with current primary-source evidence and no forced patch.
      A bounded evidence-only result is acceptable; do not invent a resolution.
- [ ] Install from the resulting lockfile with `npm ci --ignore-scripts` in the
      isolated worktree. Run Phase 0, formatting, lint, strict typecheck, build,
      full unit gate and the actual governance scripts. State local PR-check
      SKIP versus real PR-event enforcement; source scaffolds certify no browser
      behavior. Retain all existing failure/deadline/negative privilege controls.
- [ ] Run production-only and complete dependency audits and distinguish their
      scopes. Describe maintenance and validation publicly; keep any new
      repository-specific security report private as required by SECURITY.md.
      Do not dismiss/close alerts or publish a security finding through this task.
- [ ] Use existing disposable GitHub Actions for relevant native/PostgreSQL
      compatibility. No local/shared-server Docker, SSH, daemon-setting, tunnel,
      Meta, Manifest, n8n, notifications, ClickUp, secrets or account changes.
      Report unrelated runtime/harness failures separately without relaxing them.
- [ ] Preserve authored synthetic fixtures and suppression of matched values.
      Force-format changed Markdown, check whitespace and ensure every changed
      lockfile entry is explained. No customer/operator data or raw external logs.
- [ ] Push a separate draft PR with Summary, Validation, Evidence, Scope and
      Rollback, exact submitted head and immutable workflow links. Keep main
      untouched and do not merge; Codex retains acceptance and rollout authority.

Deliver a dated results record. A successful update proves compatibility of the
reviewed dependency graph; it does not approve production launch, a new feature,
rendered accessibility, remote asset changes or uncertainty settlement.
