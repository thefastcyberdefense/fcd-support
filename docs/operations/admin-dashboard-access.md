# Private admin dashboard access

Available now: implemented in Phase 5 and deployed on the local server in
Phase 6. No later development phase is needed to open it.

The administrator connects through SSH to the latest deployment's Unix socket.
On the current workstation, Codex started a loopback-only forward and verified
HTTP 200 for login and HTTP 303 to login for protected knowledge. Open:

`http://127.0.0.1:13004/login`

The forward must remain running. If it is no longer running, start it from
your own PowerShell terminal and leave that terminal open:

```powershell
ssh -N -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:13004:/home/redwan/fcd-support-host-test-p6-b1e183d/socket/admin.sock redwan@192.168.10.40
```

Do not start a duplicate forward if port 13004 is already owned by the current
SSH process. It binds only to this workstation's loopback interface. No public
admin URL or server-side admin TCP port is configured.

## Login and MFA

The existing synthetic verification identity was tested with real password/MFA,
knowledge/operations pages, logout and session revocation after deployment.
Its generated credentials persist only in the private mode-0600 server file:

`/home/redwan/fcd-support-p6-final-b1e183d/synthetic-admin-proof-credentials.json`

An authorized operator can access that file privately in their own SSH session.
The fields are login, password and the TOTP seed. Enroll the seed privately in
an authenticator using SHA-1, six digits and a 30-second interval. Never paste
the file, password, seed, OTP or cookies into chat, Git or screenshots. This is
the existing test identity; this access guide does not create/reset an account.

The dashboard supports knowledge/proposal review, owner questions, provenance,
aggregate insights, model policy and operations views under its authorization
rules. A separate scheduled-health uncertainty is currently held; the core app
and login page remain available, while normal scheduled operations are blocked.
See `incidents/2026-11-03-recurring-health-uncertainty.md`.
