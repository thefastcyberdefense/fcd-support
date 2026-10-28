# Phase 6 Synthetic Network Capacity

The local server's default Docker bridge pool is nearly exhausted by existing
test and admission stacks. Their active containers, volumes, journals and
networks must remain intact. A read-only sample found no Docker, host-route or
host-address overlap with a reserved test address block; this is a point-in-time
observation, not authorization to allocate it.

For a separately recorded synthetic deployment, permit the synthetic host
runner to adopt eight already-created, dedicated bridges: six private runtime
data networks, one private ingress network and one egress network. Keep the
existing fresh-network mode unchanged. Compose adoption of an exactly labelled
precreated bridge was verified in an isolated local test.
The disposable GitHub Actions runner exercises both the existing fresh-network
mode and a CI-only precreated-network mode using its own project namespace.

The new mode must verify exact project-derived names, immutable Docker network
IDs, bridge/local scope, internal flags, expected Compose and synthetic labels,
one IPv4 subnet per bridge, no custom driver options and no participants. The
six data bridges need the matching Compose project and logical-network labels;
the ingress and egress bridges need the dedicated synthetic-project label.
Reject extra project-labelled bridges, duplicate IDs or subnets, wrong labels,
participants and missing or replaced networks. Repeat the inventory immediately
before attaching the synthetic ingress peer. The runner must never remove or
change a precreated bridge on failure.
Explicitly refuse existing target networks, volumes and candidate image tags;
these checks must terminate the runner when a collision is found or resource
inventory is unavailable.

Subnet selection and creation are a separate server action: record exact names
and CIDRs, recheck all Docker allocations and non-default host routes and
addresses immediately before creation, and stop on overlap or drift. Preserve
all previous fixture and admission state. Do not change Docker's global address
pool, prune resources, enable provider execution or reuse the uncertain restore
target. A separate fresh target still requires an unused default or explicitly
approved isolated network allocation.
