# Health fixture ownership and closed setup reporting

Date: 2026-11-11 (Asia/Dhaka). Reviewed submitted source:
`a9a24ef58588c4558bb1212dc79a6f4b3aa73bc2` on draft PR #19.

Independent review confirms the earlier real-journal and TRACE-off corrections.
Three additional actual-function controls reproduce unrecorded same-parent actor
adoption, same-name volume replacement removal and outer setup stderr escaping
the closed reporter. All three fail before correction and pass afterward.

The fixture now registers an operation only after validating the actual complete
protected journal following controller exit. Cleanup binds exact container ID,
reference, service, command hash, revision, image and derived Compose name.
Unknown same-labeled actors remain untouched and fail the leftover gate.
Fixture container IDs/configured images are registered before post-create
inspection; a failed inspection cannot silently lose a returned actor ID.
Volumes bind recorded creation metadata, including CreatedAt. Unconfirmed
volume metadata causes preservation and a failed cleanup gate, not adoption.
Docker does not provide an immutable volume object ID; this comparison makes no
claim against indistinguishable replacement metadata or a compromised daemon.

A synchronous private-output wrapper covers main/setup and the complete inner
EXIT cleanup, including the period before a state directory exists. The
publisher runs only after the inner invocation and its EXIT trap finish; no
background publisher can outlive cleanup. Provisional volume metadata must
independently match fixture ownership, not merely equal the captured value. It publishes fixed refusal categories,
bounded line/status fields and a fixed redaction outcome; arbitrary command
bodies never become failure diagnostics. Existing per-case reporting remains
closed and retained. No production controller or recovery authority changes.

Verification: the three original RED controls fail before correction, with
additional foreign-provisional-metadata and final-cleanup controls. Final two-
file local health regression/harness verification passes **24 / 0 skips** in
**18.25 seconds**. An earlier co-run recorded **23 passed / 1 failure** from an
existing positive ledger control exceeding its 3,500 ms Windows child bound.
That exact control later passes in isolation (3.42 seconds whole command) and
the final co-run passes; no timeout cause or universal load reliability is
inferred. No deadline, assertion, retry or skip was added to obtain success.
Independent correction review finds no additional blocker; hermetic wrapper
controls verify successful cleanup, refusal privacy and preservation of work
exit 17. This is hermetic
coverage and real built-process coverage; actual Docker/PostgreSQL behavior
requires final-source disposable native CI. The earlier submitted CI is not
attributed to this correction. Historical attached-output loss remains unproven.
No server, daemon, tunnel, Meta, Manifest, n8n, account or alert action occurred.
