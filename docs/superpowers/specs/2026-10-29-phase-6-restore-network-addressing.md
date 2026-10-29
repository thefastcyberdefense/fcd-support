# Phase 6 restore network addressing

The test server's Docker default address pool is exhausted. The current restore
controller always allocates its isolated target bridge from that pool. The
uncertain synthetic promotion and both of its databases must remain untouched;
removing their networks or changing the daemon's global pools is not a safe way
to obtain another independent restore drill.

Allow an optional protected `FCD_RESTORE_SUBNET` setting for the target's new
internal bridge. An absent setting preserves Docker's existing default-pool
behavior. An explicit setting must be a canonical IPv4 network entirely within
RFC 1918 private space or the RFC 2544 benchmarking block, with prefix length
8 through 29. These bounds exclude addresses too small for the database and
jobs, public address space and ambiguous spellings. The operator chooses the
subnet; no model, rate or cost limits are changed.

Before recording restore intent or draining the source, and again immediately
before creating the target network, inspect bounded JSON output from the local
host's IPv4 routes in every table and IPv4 interface addresses. Refuse on a
non-default route or interface-network overlap, malformed or unavailable
inventory, or an invalid subnet. The default route is intentionally excluded.
Docker must still reject overlapping Docker IPAM allocations. Require the new
bridge's actual default IPAM configuration to contain exactly the requested
subnet, and recheck that fact whenever the controller verifies its identity.
Use argument arrays and closed diagnostics; never print inventory contents.

The preflight is a point-in-time check, not a lock against unrelated host
network changes. An operator must select an unused block and keep host network
configuration stable during the drill. A second preflight failure after intent
or volume creation follows existing uncertainty and preservation rules. No
existing target is adopted, no journal is resolved and no database is selected
or reattached by this change. Node and `iproute2` are required on the host only
when the optional setting is used.

Test canonical parsing and private-space boundaries; route and interface
overlaps; malformed, missing, oversized, timed-out and unavailable inventory;
the early and repeated checks; exact Docker create arguments; IPAM drift and
failed creation; and unchanged default-pool behavior. Use a real, isolated,
labelled Docker bridge for a separate optional-subnet positive and conflicting
subnet negative check. Delete only that test's verified empty network. A new
server drill still requires an exact committed action record and successful
checks for its source revision. This design does not settle the existing
promotion, pass Task 11 or authorize live-provider traffic.

Primary references:

- [Docker network creation](https://docs.docker.com/reference/cli/docker/network/create/)
  documents explicit subnets, overlap refusal and internal-network behavior.
- [IANA IPv4 address space](https://www.iana.org/assignments/ipv4-address-space)
  identifies `198.18.0.0/15` as the benchmarking allocation.
- [Linux route inspection](https://man7.org/linux/man-pages/man8/ip-route.8.html)
  documents inspection of every route table.
