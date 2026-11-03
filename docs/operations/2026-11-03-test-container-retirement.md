# Authorized old test-container retirement

Date: 2026-11-03 (Asia/Dhaka).
Status: **Reviewed and read-only admitted; actual retirement pending.**

The owner requested removing old test Docker containers and keeping the latest
deployment. They separately chose to **keep the connected Meta test webhook
stack** until a later controlled callback transition.

## Exact scope

Retire 19 obsolete actors from seven fixed isolated Phase 6 test projects:
7af70cc, 6d0210d and 67a4a4b (five each); 6faff8b, b0ba255, 8ccb9a0 and
5d35777 (one PostgreSQL actor each). Keep the latest project
fcd-support-host-test-p6-b1e183d, whose four application/database actors run
accepted `24e5667`, plus its ingress peer. Keep the three connected original
webhook/API/PostgreSQL/tunnel actors and all 23 unrelated containers.

No volume, network, image, secret/config directory, recovery journal or baseline
is deleted. Old uncertain operation actors were already absent; that fact does
not resolve their SQL outcomes. Archive sanitized container identity/mount/
readiness metadata privately before stopping/removing anything. Preserve the
original baselines and record deliberate retirement separately from earlier
unexplained actor loss.

## Reviewed action and validation

Action: `actions/2026-11-03-retire-old-tests.py`.
SHA256: `9ead80ef69b8eb63215eb91f70afa8f18ca308e3e94d4de29e8f923e7d0a2528`.

Selection requires exact old project/synthetic labels, names, roles and counts;
current operation parents and connected/latest scopes are excluded. It refuses
live old one-shot actors, enabled external execution, shared protected volumes
and AutoRemove. Old deployment locks stay held. Clients/peers stop before
PostgreSQL. Docker receives an indefinite graceful stop (`--time -1`), with
bounded client observation and no force fallback. PostgreSQL must exit cleanly,
without OOM, before removal. Only stopped exact IDs are passed to `docker rm`,
without force or volume flags. [Docker's stop documentation](https://docs.docker.com/reference/cli/docker/container/stop/)
specifies that a negative timeout disables forced termination.

The before/after comparator removes only the authorized actor IDs and their
network-member entries. Every surviving actor, volume, network definition,
saved state file and host/daemon pin must match. Private completion and a new
survivor baseline are written only after those checks. Failure preserves all
evidence; do not blindly rerun the one-use action or reconstruct old containers.

Seven authored synthetic scope/refusal/stop tests passed on Windows and Linux;
native test scratch was removed. Full read-only native admission passed with
exactly 19 targets. The first metadata-template parse failure was corrected
before admission and before any mutation. Independent read-only review approved
these exact bytes for publication, provisioning and one admitted execution.

## Dashboard and separate current health hold

The dashboard exists now (Phase 5 implementation, Phase 6 deployment). Its
login route was verified HTTP 200 and protected knowledge route HTTP 303 to
login. An SSH forward binds only local 127.0.0.1:13004 to the latest remote Unix
socket. Browser access is `http://127.0.0.1:13004/login`; login and MFA remain
required. No public admin endpoint or server port was added.

Inventory separately observed an uncertain scheduled-health job in the latest
scope after its earlier successful Phase 6 closeout. The core four containers
remain healthy. Its journal and absent-actor evidence are preserved exactly;
cleanup does not clear, retry, resolve or infer completion of that operation.
This hold blocks further normal scheduled operations and requires a separate
diagnosis/disposition. The original closeout remains bounded historical evidence.
