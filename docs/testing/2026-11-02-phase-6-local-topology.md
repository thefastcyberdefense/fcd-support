# Phase 6 local topology execution

Date: 2026-11-02 (Asia/Dhaka).
Executed by: Codex, on local Docker Desktop Linux/amd64; not the shared server.
Source: `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`.
The src/scripts/tests/infra/Dockerfile/package tree equals accepted
`9f76455be443a527ce58725fa574e7324631fd4d`. Pending review/handoff prose does
not change this tested implementation.

## Command and results

Ran the existing `bash scripts/test-phase6-local.sh` from the primary checkout.
It built its own revision-labelled application image and used authored
synthetic fixtures, test-only HTTP peers and a fresh project namespace.
The required native integration fixture image was present as Linux/amd64 with
the non-root node user. Fixture output remains ignored and is not committed.

Exit **0** in **157.32 seconds**, including the harness cleanup:

- All four rendered runtime/model/operations/restore Compose contracts pass.
- External profiles do not autostart; the missing external network is rejected.
- Native Linux admin socket checks and UID separation pass; no admin TCP
  listener is present.
- Actual network probes report **9 allowed / 20 denied** paths. The ingress
  probe is multihomed on ingress and the ordinary NAT `tunnel_egress` bridge
  from `infra/compose.phase6-test.yml`; this is not an internal-only substitute.
- Unexpected external participants and missing secret mounts are rejected.
- The conflicting-bind preflight passes (one test, one file).
- Final harness marker: `phase6_local_topology=true`.

After completion, independent project-label and exact-name-prefix inventories
find **zero** test-owned containers, networks, volumes and scoped images.
No prune, server command, public route, Meta, live model/provider or n8n action
was used. These are real local container/network observations against synthetic
peers, not live external-service or owner-server evidence.

## Gate scope

This supplies the additional full topology execution requested by original
Task 15. It does not fix PR #5's operator instructions or citations, approve
P6-GATE, install host timers, deploy updated server dependencies or resolve
the actor-loss incident. See
`docs/reviews/2026-11-02-pr-5-evidence-review.md` for the remaining review work.
