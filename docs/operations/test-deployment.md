# Test Webhook Deployment Runbook

This runbook deploys only the signed Meta webhook admission service on the Ubuntu Docker host. It is a narrow, explicitly approved test exception; it does not complete the Phase 6 or Phase 7 gates.

The test container cannot send WhatsApp or Messenger messages, call n8n, or call Manifest. Those credentials are deliberately not injected. The production WhatsApp number and production Facebook Page must remain untouched.

## Public and private boundaries

```text
Meta
  -> https://meta.fastcyberdefense.com/webhooks/meta
  -> Cloudflare Tunnel
  -> fcd-support-ingress (internal Docker network)
  -> fcd-support-api:3003
  -> fcd-support-data (internal Docker network)
  -> PostgreSQL

fcd-support-api -> mnfst_internal (attached for later private validation; no key is injected)
```

No API or database port is published on the Ubuntu host. The Cloudflare route must use:

- Hostname: `meta.fastcyberdefense.com`
- Path matcher: `^/webhooks/meta$`
- Service: `http://fcd-support-api:3003`

The matcher is a route rule, not part of the callback URL. Never give Meta a URL containing `^`, `$`, or `%5E`.

## Protected server state

The following files are server state and must never be committed or copied into the repository:

- Runtime configuration: `/home/redwan/.config/fcd-support/runtime.env`
- Tunnel token: `/home/redwan/.config/fcd-support/cloudflared.token`

Both files must be owned by the deployment account and mode `600`. The repository contains names and examples only, never values.

Before deployment, confirm these settings are nonblank in `runtime.env` without displaying their values:

- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `META_APP_SECRET`
- `META_VERIFY_TOKEN`

The test deployment does not require `META_PAGE_ACCESS_TOKEN` or a WhatsApp access token.

## Deploy or update

On Windows, test, commit, and push the intended revision. On Ubuntu, deploy only that committed revision:

```bash
cd /home/redwan/apps/fcd-support
git fetch origin
git pull --ff-only origin main
./scripts/configure-test-runtime.sh
./scripts/deploy-test.sh
```

`deploy-test.sh` is idempotent. It:

1. validates the protected runtime file;
2. creates the private attachable `fcd-support-ingress` network if absent;
3. attaches `fcd-support-cloudflared` without recreating it;
4. validates the Compose model without printing interpolated secrets;
5. pulls the pinned PostgreSQL image and builds the pinned API image;
6. starts PostgreSQL and applies migrations;
7. starts the API on container port `3003` with no host port;
8. runs local topology and public-path verification.

Run the checks again at any time:

```bash
cd /home/redwan/apps/fcd-support
./scripts/verify-test-deployment.sh
```

The verifier proves:

- the API and database are healthy;
- neither publishes a host port;
- the tunnel and API share only the private ingress network;
- PostgreSQL is absent from the ingress network;
- the public callback returns an exact challenge for the protected token;
- `https://meta.fastcyberdefense.com/health` returns `404`;
- an unsigned public webhook event returns `401`.

The script never prints the verification token.

## Configure Meta

Only after `verify-test-deployment.sh` passes, enter these values in both the WhatsApp and Messenger webhook setup screens:

- Callback URL: `https://meta.fastcyberdefense.com/webhooks/meta`
- Verify token: the exact `META_VERIFY_TOKEN` value already stored in `/home/redwan/.config/fcd-support/runtime.env`
- Client certificate: off

Open the protected environment file locally in a private editor to copy the token. Do not use `cat`, `echo`, shell history, screenshots, chat, or Git to transfer it.

Select **Verify and save**. Then retry subscriptions for the dedicated WhatsApp test number and Messenger test Page only. Start Messenger with `messages`, `message_deliveries`, `message_reads`, `message_echoes`, `message_reactions`, `message_edits`, and `messaging_postbacks`; add other reviewed fields only when the application implements and tests their behavior.

App development mode may deliver only test events and events from people with an app role. Publishing and production permissions are separate later gates.

## Rollback

Stop the test API and database while preserving the PostgreSQL volume and the independently managed tunnel:

```bash
cd /home/redwan/apps/fcd-support
./scripts/stop-test-deployment.sh
```

To roll application code back, identify a previously tested commit on Windows, push that state through the normal reviewed Git workflow, pull it with `--ff-only` on Ubuntu, and run `./scripts/deploy-test.sh` again.

Do not run database migration rollback against retained data without a reviewed migration-specific procedure. Do not delete `fcd-support-postgres-data` as a rollback step.

## Move to another server

1. Install Docker Engine, the Compose plugin, Git, and the Cloudflare tunnel container on the new Ubuntu host.
2. Clone the GitHub repository to `/home/redwan/apps/fcd-support` and check out the exact reviewed commit.
3. Create `/home/redwan/.config/fcd-support` as the deployment user with mode `700`.
4. Transfer `runtime.env` and `cloudflared.token` through a separate encrypted operator-controlled channel; set each file to mode `600`. Never put either file in Git.
5. Ensure the existing Manifest deployment exposes the external Docker network `mnfst_internal` if model-path testing will be performed later.
6. Start the dedicated `fcd-support-cloudflared` container using its protected token file and the existing pinned-image procedure.
7. Run `./scripts/configure-test-runtime.sh` and `./scripts/deploy-test.sh`.
8. Run `./scripts/verify-test-deployment.sh` before changing any Meta callback or subscription.

Moving an existing database is intentionally not automated by this test runbook. Encrypted backup, isolated restore, and deletion-ledger reapplication remain blocked Phase 6 work. Until those gates pass, use an empty test database on a replacement host or obtain separate approval for a reviewed data-migration procedure.

If the public hostname or tunnel changes, update Cloudflare first, re-run the public-path and negative-path tests, and only then update Meta. This never authorizes a production WhatsApp number migration, unlink, registration, or coexistence change.
