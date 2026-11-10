# Full-duplex health acknowledgement exchange

Date: 2026-11-09 (Asia/Dhaka). Diagnostic source:
`4f1dc7bfc1e05d5e134b9bc528ecf2f7ae58f1f3`.
Latest main 9607019 is integrated as 603b3df before final validation.

## Measured boundary and design

The closed producer observer in runtime run 42647195109 reports both
`synthetic_health_ack_diagnostic=empty` and
`synthetic_health_daemon_diagnostic=completed` in all four lanes:
129263527196 (stress/fresh), 129263527629 (stress/precreated), 129263527661
(ordinary/precreated), and 129263527909 (ordinary/fresh). Existing exited/0
and ownership checks preceded observation. This establishes that a canonical
producer stdout frame was present in daemon logs but missing from attached
capture in those runs. It does not identify the lower-level Docker cause or
settle any previous/shared-server operation.

Three approaches were considered within the approved lifecycle:

1. Retaining or polling daemon logs keeps dependence on a separately buffered
   channel and adds ambiguous retry/completion behavior. Do not adopt that as
   lifecycle authority. The closed observation remains diagnostic only.
2. Keep the existing attached exchange fully duplex until its output closes.
   This preserves the framed stdio protocol, uses existing configured deadlines
   and needs no extra mount or recovery authority. Selected correction.
3. An acknowledgement file would introduce new mount, persistence and trust
   contracts. It is unnecessary for this bounded correction and is deferred.

The host's previous `printf | docker start --attach --interactive` closes its
input writer immediately after sending the frame. The selected health helper
uses a coprocess, duplicates then closes original descriptors, writes one frame,
keeps its writer open while forwarding attached stdout to the existing bounded
reader, closes both descriptors and waits for the coprocess status. The framed
reader's preserved/paused/unreferenced stdin permits natural process exit
without requiring EOF. Nonzero transport, descriptor/write/forwarding failure,
invalid complete output or final actor/exit failure remains uncertain.

The full bounded NUL-aware reader, canonical acknowledgement, Docker wait 0,
exact owned exited/0 checks, verified removal and durable completion ordering
remain unchanged. No log fallback, acknowledgement retry, second actor start,
uncertain-state clearing or SQL settlement inference is introduced. Non-health
and promotion exchanges retain their existing behavior. The Docker command's
configured timeout and termination grace bound the upstream process lifetime.

## Verification

- RED: an actual TRACE/lifecycle fixture distinguishes EOF from a still-open
  input writer before replying. The old writer closes and fails; the duplex
  helper passes. This is a deterministic transport-port control, not a claimed
  reproduction of the exact Docker CI mechanism.
- The fake native Docker port now consumes one bounded newline frame instead of
  waiting for EOF, matching the actual health input contract. Its existing input
  equality, state, cleanup, uncertainty and no-replay assertions remain.
- The first broader check retained **2,157 passed / 461 skips / 1 failure**:
  an older scheduled-job fake waited for EOF instead of consuming one frame.
  That fake now reads one newline frame while preserving its argument/input
  assertions and unchanged timeout. This failure is not erased by later results.
- Four focused suites pass **190 / 0 skips** in **19.46 seconds**. The networkless
  local Linux lifecycle harness passes **38 / 0 skips** in **30.77 seconds**,
  with its existing ownership/cleanup checks.
- A fresh exact-labeled local Docker actor ran the actual transpiled health
  reader with the actual sourced host duplex helper, not a copied exchange.
  It used an image ID with no implicit volumes, UID 1000:1000, network none,
  read-only root, dropped capabilities, resource limits and log driver none.
  Attached canonical output, wait 0 and exact owned cleanup passed. This proof
  does not run application PostgreSQL persistence; that remains a separate lane.
- Independent read-only review found no important descriptor, status,
  authority, privacy or lifecycle issue. Final full-source verification and
  fresh immutable CI results are recorded before acceptance.

The prior local Docker baseline did not reproduce output loss. Keeping the
writer open is a targeted protocol correction; only new runtime evidence can
establish its effect on the measured CI boundary. No server or provider action
occurred, and the deployed uncertain-health hold remains preserved.

## 2026-11-10 final local verification

Fresh `VITEST_MAX_WORKERS=2 npm run check` exits 0: Phase 0, formatting,
lint, strict typecheck, build and **2,158 passed / 461 platform skips** across
134 files. Vitest duration is **276.89 seconds**; the complete command takes
**322.50 seconds**. The tracked source diff hash remains
`339836253ac9a9a90a9336ccb5216e96eacd3243` before/after the run; no source
changed during verification. The prior session's unavailable process result is
not used as evidence. A fresh independent static review of the full production
patch and final helper found no important issue. No extra runtime tests or
server actions were performed by that reviewer.

Forced formatting of this final evidence addition and whitespace validation
pass before publication. Immutable final-source CI remains a separate check;
no historical failure or deployed uncertain job is settled by this local gate.
