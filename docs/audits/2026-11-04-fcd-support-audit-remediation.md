# Fast Cyber Defense Support (`fcd-support`) - Technical Audit & Remediation Plan

**Audited revision:** [`443d05b94dcffcafa17dea98fe6b6443fb5d8006`](https://github.com/thefastcyberdefense/fcd-support/commit/443d05b94dcffcafa17dea98fe6b6443fb5d8006)  
**Status:** **NO-GO for production and Phase 7 live execution until the current blockers are closed.**

## Executive findings

The local implementation has strong defensive foundations, but production readiness is blocked by the boundary between source evidence and live state:

1. The current uncertain scheduled-health journal remains open and correctly blocks scheduled operations.
2. The deployed runtime is behind accepted dashboard grant corrections; authenticated dashboard re-test is pending.
3. PR #10's promotion observer bounds diagnostics but does not identify the validator/container root cause.
4. Phase 7 AC-01 through AC-36 remain readiness mappings, not current live acceptance evidence.
5. Phase 8 lacks the signed decision, legal/privacy wording approval, token rotation proof, WhatsApp coexistence result, and n8n/on-call ownership evidence.

## Priority remediation findings

### FCD-P6-001 - Critical - Held uncertain health job

Preserve the exact state file, journal, database and inventory. Do not clear, retry, infer SQL outcome, or use broad cleanup. Perform a separately approved read-only diagnosis, establish actor ownership and database postconditions, then record an append-only terminal disposition before any new scheduled run.

### FCD-P6-002 - High - Dashboard grant correction not deployed

Deploy the accepted least-privilege grant correction only after the held state is safely settled. Re-run empty/populated/privacy-held/revoked-role dashboard tests and the authenticated seven-route smoke matrix without broadening privileges.

### FCD-P6-003 - High - Promotion boundary unresolved

Keep PR #10 draft. Preserve failed run IDs, retain only bounded closed-v1 diagnostics, reproduce fresh/precreated lanes, and resolve the container/validator failure separately from acknowledgement logic.

### FCD-P6-004/FCD-P6-005 - High - Timer and reboot evidence

Verify rendered systemd units, ownership, modes, hashes and `Persistent=true` replay behavior. Add an approved full-host reboot/recovery runbook; container restart is not host outage evidence.

### FCD-P6-006/FCD-P6-007 - High - Enabled topology and secret mounts

Make runtime role validation mode-aware. When outbound execution is false, there must be no outbound container, provider egress network, or Meta secret mounts. When enabled, require exact worker, secret and network evidence.

### FCD-P6-008 - High - Manifest safeguards unverified

Keep model execution disabled until recording-off, deletion/retention, provider allowlist, deployment ceilings and private-route attestations are independently verified.

### FCD-P6-009/FCD-P6-010 - High/Critical - Phase 7/8 incomplete

Execute the AC-01..AC-36 matrix only on approved non-production Meta/Manifest assets. Then create a signed Phase 8 GO/NO-GO record. A green local suite is not live readiness.

## Source-level remediation backlog

- Thread `AbortSignal` through health, readiness, PostgreSQL and worker operations; timeouts must cancel or classify side effects as uncertain.
- Make non-cooperative worker shutdown return `drained`, `aborted`, or `uncertain`, and reconcile leases before termination.
- Persist `delivery_unknown` for outbound and notification failures after dispatch; never blind-retry ambiguous sends.
- Add login/MFA throttling and fail-closed production cookie/origin checks.
- Add application-level request timeouts, bounded receipt concurrency, and a documented edge rate policy for Meta retries.
- Add exact runtime grant preflight and make default `npm test` clearly distinguish unit-only from integration/native gates.
- Add backup provenance/allowlist controls before promotion of restored state.
- Add a current-status block to tracker/evidence docs so historical passes cannot be mistaken for present readiness.

## Phase 7 and Phase 8 acceptance gap

The detailed acceptance matrix must individually prove device delivery, signature rejection, deduplication, stale events, bilingual human scoring, takeover, consent/opt-out, deletion, restore, tunnel isolation, container hardening, Manifest safeguards, outbound ambiguity, rate limits, restart recovery, API support window/token rotation, coexistence eligibility, access requests, correction handling, race conditions and migration cycles.

## Verification boundary

No SSH, shared-server Docker/systemd, Cloudflare, Meta, Manifest, n8n, provider, or production action was executed for this report. Use the repository's approved runbooks and preserve all uncertain evidence.
