# Phase 6 Operations Image Mount Correction

This Task 11 correction follows the owner's standing delegation to finish the
approved Phase 6 plan. It restores an existing isolation contract; it does not
authorize a production launch or external provider traffic.

The pinned PostgreSQL base image declares a volume. The operations image
inherits it, so Docker attaches an anonymous `/var/lib/postgresql` volume even
to networkless validators and to promotion jobs. Actual Docker tests reproduced
an extra validator mount and an extra job mount. Normal `--rm` cleanup does not
make the unintended mount acceptable, and an interrupted fixture can leave an
anonymous volume behind.

Switching validators to the application image would leave the promotion job's
extra mount. Accepting the extra mount would weaken the existing proof. Instead,
retain the complete built operations filesystem in an intermediate stage and
copy it into a final `scratch` stage, which resets inherited image-volume
metadata. Explicitly restore the existing user, entrypoint, command, working
directory, environment, labels, exposed-port metadata and stop signal. Keep all
upstream images pinned. This approach passed an isolated local canary for Node,
age, pg_dump and pg_restore without a declared image volume.

Require actual Docker inspection: the final image declares no volumes, a
networkless validator has zero mounts, and an operation with one explicit
archive mount has only that mount. Verify the final image's metadata and real
toolchain, the existing native backup/restore/promotion tests, full code checks
and GitHub Actions. The retained old images and unresolved server jobs remain
untouched. A new server restore drill requires its own exact committed action.
