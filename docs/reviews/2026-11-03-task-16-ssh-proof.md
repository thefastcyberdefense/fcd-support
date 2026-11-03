# Task 16 actual SSH authentication proof

Date: 2026-11-03 (Asia/Dhaka).
Status: **Prepared and corrected; execution requires successful fresh deployment and audit.**
Scope: fresh `b1e183df3e7c319483f863346925b38c4f149ba5` only.
Action: `docs/operations/actions/2026-11-03-admin-ssh-proof.py`.
SHA256: `85228d2c6658a941e3b963be2ea3a6e784e6c84d5c9bb4e7fc3badb40748f82f`.
Tests SHA256: `a288dc6c5598175edf7b0f6c6bcce77e8e48cffe523e0624624141c86b36ac19`.

## Concrete scope and prerequisites

This is an acceptance proof for the approved isolated test deployment, not a
live integration or production identity. Before any identity write it requires
the exact clean checkout, protected completed-deployment marker, ready selection,
no active job, exact healthy/read-only/non-root admin container at the selected
revision, and no admin published port. It refuses an occupied client browser port.
Do not run against either failed scope or rerun after partial bootstrap.

The client generates a random synthetic login password and MFA seed in memory.
Through encrypted SSH stdin, an audited remote program invokes the existing
loadRoleEnvironment/loadAdminConfig/PostgresAdminIdentity/runAdminBootstrap
interfaces inside that exact admin container as UID/GID 1000. It receives only
the admin role's existing mounted secret files, never an owner database credential.
The real initial-bootstrap path refuses an existing account. All three external
execution flags must remain false and the listener must be Unix-only.

Generated verification credentials are saved only to an exclusive mode-0600 file
under the fresh protected action root before bootstrap. No values appear in
command arguments, output, Git, logs or model input. The file is the one-use
boundary: any failure preserves it and stops; no duplicate bootstrap is inferred
safe. The existing bootstrap-completed marker is written only after its closed
success acknowledgement. The test account remains synthetic; owner provisioning
and its later retirement are separate operational responsibilities.

The owned OpenSSH client binds only 127.0.0.1:13004 and forwards to the configured
fresh host Unix socket. Host-key checking and batch mode remain enabled; no SSH
policy or permissions are changed. Only its own process is terminated/reaped.

## Independent review and direct corrections

Read-only review identified two Important issues, both corrected before use:

1. The implemented admin redirects are 303, not 302. Every expected redirect
   now matches the actual handler. Existing admin tests cover password/MFA,
   origin, CSRF and logout behavior; prior actual read-only SSH confirms the
   unauthenticated 303. Actual successful SSH password/MFA remains unclaimed.
2. Port availability alone cannot prove listener ownership. After TCP connect,
   before any HTTP request/header/body, the Windows proof queries the exact
   established server-side loopback tuple and requires its owner to be the SSH
   PID it created. A replacement listener cannot receive credentials through
   an unverified connection. Wrong, missing and duplicate owners fail closed.

The ownership regression failed because a wrong owner still received an HTTP
request, then passed after the guard. Three hermetic guards pass, including a
matching-owner success control and zero HTTP transmission on wrong/absent/
duplicate ownership. The initial test setup needed a missing import; after that
it reproduced the actual failure. Python, remote Python and embedded Node syntax
checks pass. No test account or live credentials were created by these checks.

A separate real read-only SSH probe on the prior healthy runtime verified
login 200, unauthenticated knowledge redirect 303, wrong-Origin refusal 403,
established tuple ownership and owned-process reaping. It creates no identity
or authenticated session and is not a successful MFA proof.

Reviewer boundaries remain explicit: live deployment/database/socket/clock/SSH
conditions require execution; synthetic account retirement and real owner
provisioning are not performed by this one-use acceptance test. No deferred minor
finding was reported.

## Execution and required evidence

Commit/push the exact proof, tests and runbook before execution. After the fresh
public deployment audit passes, run the proof once from this Windows checkout.
It checks login/unauthenticated behavior, missing/wrong origin, wrong password,
real password-to-MFA transition, wrong MFA CSRF, correct MFA, authenticated
knowledge/operations pages, logout CSRF and revocation. Only closed boolean
outcomes are printed. Captured HTML, cookies, password, seed and OTP never print.

Successful proof still does not install host timers or finish Task 16 by itself.
Any failure preserves the new private credential/marker evidence and requires
review before a continuation; it never targets another project or old database.
