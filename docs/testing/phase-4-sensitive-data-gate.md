# Phase 4 Sensitive-Data Gate Evidence

Date: 2026-09-11 (Asia/Dhaka)

## Scope

This checkpoint completes approved Phase 4 plan Task 10. It adds a pure,
deterministic sensitive-data inspection boundary and reviewed English/Bangla
safe-response text. It does not perform inference, contact Manifest or a model
provider, persist customer content, send a message, deploy, or mutate external
infrastructure.

## Implemented controls

- Inspection accepts a deployment-supplied maximum input size and fails closed
  on excessive text, unpaired surrogates, and disallowed control/format code
  points. The library default is replaceable by a validated operational value,
  so deployments can tune the bound without changing source.
- Closed recognizers cover passwords, authentication secrets and Basic auth,
  OTP/recovery values, API keys, bearer/access tokens, cookies, sessions,
  payment-card/CVV and bank data, private keys, credential files, and sensitive
  incident evidence.
- Multiple matches and high-risk evidence classes always block. One lower-risk
  match can produce a typed marker only when deterministic removal leaves a
  bounded, explicit ordinary support question. Otherwise the result blocks.
- Blocked results contain no input or sanitized excerpt. Redacted results
  contain only the ordinary question plus a closed typed marker; no match value,
  offset, capture, or unrestricted reason is returned.
- Safety responses cover sensitive-data, limit exhaustion, provider
  unavailability, validation failure, and human escalation using fixed reviewed
  English/Bangla text. No model participates in classification or wording.

## Test-first and validation evidence

- Initial focused run: both suites failed because the three Task 10 modules did
  not exist.
- First implemented focused run: 33 tests passed across 2 files.
- Added regression cases first for Basic auth, CVV, `.env` credential files, and
  overlapping `one-time password` classification; the focused run failed all
  four new cases before the recognizer fix.
- Self-review added a normalization-expansion regression and enforced the same
  supplied size bound before and after Unicode NFKC normalization.
- Final focused run: 38 tests passed across 2 files.
- `npm run check`: Phase 0 validator, formatting, lint, strict type checking,
  build, and 355 unit tests across 30 files passed.
- The unchanged Task 9 PostgreSQL baseline is 296 tests across 21 files. Task 10
  is pure and changed no schema or persistence code, so PostgreSQL tests were
  not rerun for this checkpoint.

All cases use conspicuously synthetic non-operational fixtures. Assertions prove
that detected values do not occur in serialized results, generated errors, or
logger-shaped contexts. No credential, token, customer data, raw message,
external identity, or secret value is included in this evidence.

## Deliberate non-claims

- No live browser, Manifest, model, provider, Meta, n8n, tunnel, SSH, deployment,
  or production test was run for Task 10.
- This pure gate does not yet resolve FAQs, create reply drafts/escalations, or
  call a model. Those integrations remain Tasks 11–12 and later Phase 4 work.
