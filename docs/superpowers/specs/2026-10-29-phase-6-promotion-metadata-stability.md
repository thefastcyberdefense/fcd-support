# Phase 6 promotion metadata stability

The fresh `6faff8b` synthetic restore completed. Promotion then refused and left
the selection/job uncertain with writes possible. The recorded job actor is
absent; its exact failure point is unavailable. Preserve both databases,
volumes, networks, completed restore record, job and override. Do not retry,
resolve, clear or roll back that scope.

A separate read-only probe used the actual
`OPERATIONS_RUNTIME_CONTAINER_FORMAT` against the live source and target
PostgreSQL actors. Across ten reads each, the source raw projection was stable;
the target raw projection changed four times between adjacent reads. Both had
two mounts. Every parsed observation was identical after sorting the complete
mount records, without dropping fields or duplicate entries.

`operations_promotion_host_snapshot` currently compares repeated source/target
projections as raw strings. Docker mount-array order can therefore cause refusal
without any resource change. This is a demonstrated independent blocker; it is
not a recovered trace of the removed promotion job.

Preserve every fresh observation and every existing identity/capability check.
Compare order-insensitive mount collections semantically using the existing
trusted compiled TypeScript validation boundary. Prefer passing the terminal
source/target observations into that validator alongside the existing samples,
so no extra host runtime, Docker privilege or authority is introduced. An
equivalent existing canonical validation port is acceptable if it retains all
observations. Simply removing the recheck or ignoring validation errors is not
acceptable. Do not sort command arguments or other ordered arrays globally.

Regression acceptance requires deterministic mount-order permutations within a
snapshot and between snapshots to pass, while changed source, destination,
type/name, write mode, propagation, extra/missing mounts and duplicate mounts
still refuse. Preserve operation-reference binding, cluster identity, source
freeze, membership and two fresh challenges. Bound inputs and emit only closed
results. Use newly authored synthetic fixtures and a scoped real-Docker
projection check; do not depend on random Docker ordering for CI correctness.

The correction adds no resolver or readiness bypass. Existing uncertain scopes
remain untouched. Validate focused/native tests and the full applicable gates,
commit/push and require exact-source CI before any separately recorded fresh
server drill. Phase 6 remains open.

Review correction: the host-wide bind inventory is also an unordered mount-derived
collection. Compare every complete record while preserving multiplicity; two
mount destinations can legitimately project identical source records. Commands,
entrypoints and execution flags remain ordered. The actual Docker projection
probe uses the compiled production canonicalizer, not a test-only copy. These
corrections preserve the existing observation and authority boundaries.
