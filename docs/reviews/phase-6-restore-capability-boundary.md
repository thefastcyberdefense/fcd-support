# Phase 6 restore capability boundary — decision proposal

Status: proposed, not approved. This document authorizes no deployment, network
change, secret mount or live traffic. Phase 6 remains incomplete.

## Why a decision is needed

The approved design requires an isolated restored PostgreSQL instance, current
deletion evidence from the quiesced source and explicit owner-only bootstrap.
It does not spell out how those capabilities are divided between one-shot jobs.
Automatic approval review rejected the proposed combined Compose change because
it joined restore/promotion jobs to the source operations network and mounted
all runtime/bootstrap password files into the restore job.

The rejected patch was not applied. In particular, neither the production
Compose definitions nor any server network or secret mount changed.

A job that can reach the source PostgreSQL instance should not simultaneously
receive the complete runtime/migrator password set. The implementation should
separate those capabilities rather than approve that combined authority.

## Approaches

| Approach                                                                                                           | Tradeoff                                                                                                                           | Recommendation           |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| One combined restore job with source access and bootstrap passwords                                                | Simple orchestration, but combines source reachability with credentials for every runtime role. This is the rejected scope.        | Do not use.              |
| Separate isolated bootstrap/migration jobs and narrow reconciliation jobs                                          | More one-shot steps; preserves current database libraries while separating password provisioning from source reachability.         | Recommended.             |
| Target jobs have no source-network access; a source-only freeze/export job supplies bounded host-mediated evidence | Strongest network separation, but requires a new cross-process checkpoint authority protocol and more interruption/recovery cases. | Viable, larger refactor. |

## Recommended split-job design

The source remains PostgreSQL-authoritative. All applications are verifiably
quiesced during final checkpoint refresh, reconciliation and promotion. Every
job is revision/image pinned, non-root, read-only apart from its private tmpfs,
resource/time bounded, under the deployment lock and durable job journal.

| Job                                                              | Networks                                                                                                           | Credentials/capabilities                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source archive/checkpoint export                                 | Existing source operations bridge only                                                                             | Its existing dedicated export capability and signing/encryption material; no restored-database owner or runtime password set.                                                  |
| Encrypted stream restore                                         | New isolated target bridge; source operations bridge only if current catalog/physical-source verification needs it | Dedicated metadata-only source archive reader, distinct target restore owner, archive verification/decryption material. No runtime/bootstrap passwords or migrator credential. |
| Target grant preparation and convergence                         | Isolated target bridge only                                                                                        | Distinct target owner and the existing dedicated FCD Support bootstrap password files. No source database URL, source network, provider or admin credentials.                  |
| Target forward migration                                         | Isolated target bridge only                                                                                        | Restricted target migrator. No source network or owner/runtime password set.                                                                                                   |
| Current deletion reconciliation and final promotion verification | Isolated target bridge plus the source operations bridge                                                           | Dedicated source checkpoint capability, distinct target owner and required deletion/checkpoint keys. No runtime/bootstrap password set or migrator credential.                 |

The source archive-reader capability should be limited to backup-catalog
metadata and physical identity checks rather than the full business-table read
permissions of the ordinary backup exporter. Source reconciliation sessions are
read-only; the existing explicit checkpoint-export job alone maintains checkpoint
bookkeeping. The restored PostgreSQL service itself stays on its isolated bridge.
No API, worker, admin, Manifest, n8n, ingress or provider service joins that bridge.

The restore owner password must be separate from the source PostgreSQL owner's
password. Neither owner credential enters runtime application containers.
Runtime/bootstrap password files are mounted read-only only for the bounded,
target-only bootstrap job. OpenClaw and Hermes keys are never used.

## Freshness and failure rules

- Historical restore records describe resources; they never authorize attachment.
- Promotion refreshes current deletion evidence and retains the source freeze
  through the final target commit. Fresh host checks use bounded, replay-resistant
  stdio challenges; no Docker socket or broad host bind enters a job.
- The host independently checks source quiescence and exact target volume,
  network, image, physical system identifier and revision before switching.
- Ambiguous completion preserves journals, intent records, both volumes and the
  recovery hold. There is no blind replay, automatic cleanup or old-volume fallback.
- External execution stays disabled after switching until the separate recovery
  policy review. Production assets remain untouched.

## Implementation and validation after approval

Refactor the existing combined SQL driver into the bounded legs above, retain
the tested restricted migration and current-deletion primitives, and update the
Compose contract and host controller together. Tests must prove that a job on
the source bridge cannot obtain runtime/bootstrap/migrator credentials, that a
bootstrap/migration job cannot reach the source bridge, and that interrupted
promotion never attaches an unverified target or loses either volume. Complete
the full local failure matrix and P6 gate before preparing the exact server
deployment handoff. Approval of this design still does not authorize deployment.

## Decision requested

Approve the recommended split-job design, or select the fully offline/host-mediated
alternative. The combined-authority approach remains rejected.
