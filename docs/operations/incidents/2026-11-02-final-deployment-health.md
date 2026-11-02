# Fresh Task 16 deployment stopped at health input

Date: 2026-11-02 (Asia/Dhaka).
Status: **OPEN; preserve the stopped scope and uncertain health journal.**
Selected source: `7af70cc77196813b92d8365567150153996b790a`.
Committed executor: `26ba72af8589aeeda3e8dcbb85a1de80fd464d70`.
Executor SHA256: `49eda6f6994ae4071928fcc5cdbe545452d85aec0f937879f269ced02e98bcb0`.
Fresh scope: `fcd-support-host-test-p6-7af70cc`.

## Actual outcome

The reviewed action ran once after fresh admission. Private deployment and its
verification checks passed. Both scheduled-backup invocations and the owning
maintenance scheduler's retention, deletion, lease-recovery and learning jobs
completed. This confirms the generated maintenance correction in this fresh
server scope; it does not resolve the earlier `6d0210d` maintenance journal.

The next health invocation produced `operations_job_uncertain` and
`operations_schedule_failed`. The durable journal is `uncertain/health`, selection
is `ready`, and the exact health actor is absent. No deployment-completed marker
exists. Health success, timer rendering/install, actual SSH authentication and
final Task 16 handoff are not claimed. No verification identity was created.
Do not rerun the one-use executor, clear its journal or infer SQL outcome.

A separate post-stop read-only comparison against this attempt's saved baseline
passes for all surviving older actors, network membership, volumes, old state
and protected prior evidence, and boot/daemon pins. The fresh runtime has four
roles, all running/healthy. The earlier original baseline and its missing-actor
incident remain unchanged; this is not a claim that its full audit is repaired.
A bounded exact-actor event query returned no retained event and supplies no
settlement or attribution authority.

## Reproduced transport defect and direct correction

A fresh, network-disabled local Docker diagnostic distinguishes the actual
transport semantics: ordinary `docker create --interactive` sets StdinOnce=true
and reaches EOF; Compose with stdin_open=true sets StdinOnce=false and the same
reader remains open until its authored timeout branch exits 17. Both exact
labelled diagnostic actors were removed; no scoped network remained. Tests used
Docker Desktop, not the shared server.

The health CLI waits for EOF and the owning host sends JSON without a terminator.
A real held-open PassThrough regression reproduced `health_input_invalid` instead
of completion. The reader now completes a valid JSON value at a newline, closing
its input iterator; the host emits that newline. Existing EOF compatibility,
16,384-byte cap and timeout remain. Split/pretty JSON and malformed EOF are tested.
The first extraction attempt exposed a variable-shadowing error; after correcting
that, the intended timeout regression was RED, then GREEN. No server SQL outcome
is inferred from the local reproduction or source reasoning.

Disposable private-runtime CI now runs the actual owning health scheduler after
backup and before checkpoint/recovery. A closed health diagnostic and health
failure refusal prevent later recovery/cleanup. Earlier PR #6 green lanes ran
real maintenance but did not include this real health transport boundary.

Independent review found leading blank chunks could be mistaken for an empty
frame. The held-open leading-blank regression failed, then passed after requiring
successful nonblank JSON parsing. The first full gate also exposed the existing
trusted-transport diagnostic test's 5,000 ms timeout (1,959 passed / 438 skips,
285.96 s). Its parser unnecessarily spawned a validator for every general trace
line and accepted duplicate. Bounded prefix/deduplication checks now avoid that
work while retaining the closed validator and exact output/refusal assertions;
no deadline was raised. Focused final tests: **40 passed**, three files, **4.43 s**.
The corrected full gate and exact-source CI remain integration prerequisites.
No new server retry or successful health collection is claimed yet.

Separate read-only real SSH forwarding was verified with an owned client process:
login GET 200, unauthenticated knowledge redirect 303 and wrong-Origin login 403.
Each established connection's server-side loopback tuple was checked as owned
by that exact SSH PID before HTTP transmission; the owned forward was reaped.
No credential, identity, authenticated session or database mutation was used by
these three requests. This is actual SSH transport/unauthenticated behavior,
not successful password/MFA or final handoff evidence. The larger authenticated
proof remains an unexecuted private draft, with redirect/peer-ownership review
corrections and three passing hermetic guards; it must target a successful scope.

## Remaining boundary

Keep both November 2 uncertain scopes and all older scopes intact. A further
server attempt requires a distinct reviewed source/project, current capacity/
network admission and preservation of both failed scopes. The drafted SSH proof
has not executed and must target a successfully completed fresh deployment.
Privileged timers remain unavailable to noninteractive sudo. No other project,
model/provider, Meta, n8n, tunnel or production action is included in this fix.

Final local validation on 2026-11-03 (Asia/Dhaka): full check exit 0, **1,961
passed / 438 platform skips**, 131 files, **283.78 s**. The compiled corrected
reader also completed a newline frame through actual local Compose
StdinOnce=false, exit 0, with zero scoped actor/network/volume leftovers.
See `../../testing/2026-11-03-health-input-correction.md`. Hosted CI and a new
reviewed server attempt remain required; the stopped scopes stay untouched.
