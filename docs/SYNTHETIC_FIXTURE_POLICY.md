# Synthetic Fixture And Evidence Policy

## Purpose

This policy governs test fixtures, database seeds, local HTTP fakes, examples,
evaluation prompts, diagnostic evidence, and log assertions in this repository.
It ensures development can reproduce provider-shaped behavior without copying
customer data, operator data, production identifiers, credentials, or raw
external payloads into Git.

The rule is source-based, not appearance-based: data derived from a real person,
conversation, account, request, database, recording, or log remains real data
even after hashing, truncation, masking, encryption, or partial replacement. It
must not be used as a fixture.

## Scope

This policy applies to:

- unit, integration, migration, contract, and acceptance tests;
- fixture builders, seed scripts, local databases, and HTTP fake responses;
- webhook, provider, Manifest, n8n, backup, and restore examples;
- English and Bangla evaluation prompts and expected answers;
- documentation examples, troubleshooting notes, CI output, and test evidence;
- screenshots, recordings, exports, or other artifacts considered for inclusion
  in the repository.

It does not authorize access to live data. Test-asset evidence must still follow
the approval boundaries in `docs/TODO.md`.

## Allowed Synthetic Data

Every committed fixture value must be intentionally authored for testing and
must be safe if published. Prefer values that make their synthetic origin
obvious without relying on surrounding context.

### Identifiers

- Text identifiers use a marker such as `synthetic`, `test`, `fixture`,
  `example`, `TEST`, or a locally generated random UUID.
- Provider-shaped numeric identifiers use fixed, invented values owned by the
  test. They must never be copied from Meta, Manifest, n8n, a phone, a browser,
  a database, or a log.
- Phone-shaped fixtures use non-routable test values such as the repository's
  `1555...` values. Tests must never send traffic to them.
- Email and domain fixtures use reserved names such as `example.com` or
  `example.invalid`.
- Network examples use loopback or documentation ranges unless an operations
  contract intentionally asserts an approved project endpoint.
- Dates and timestamps are fixed invented values. They must not reproduce a
  customer's or operator's activity timeline.

### Content

- Message text, consent wording, FAQ questions, incident descriptions, names,
  addresses, and bilingual evaluation content are newly authored synthetic text.
- Content should include an explicit `Synthetic` or `TEST` marker when that does
  not interfere with the behavior under test.
- Provider payloads preserve only the minimum schema required by the test. Each
  leaf value is replaced independently; copying a real payload and changing only
  its obvious fields is prohibited.

### Test Credentials And Connections

- Credential-shaped test values are nonfunctional sentinels beginning with
  `synthetic_`, `test_`, or an equivalent obvious marker.
- Test database URLs use loopback, an isolated test database name, and a
  non-production role. URLs used to prove rejection may use `example.invalid`.
- A test secret may meet configuration length requirements but must not reuse,
  resemble, encode, or derive from any real secret.
- Approved project hostnames may appear only in deployment contract tests and
  operations documentation. They must not include credentials, query secrets,
  account identifiers, or unrestricted routes.

## Prohibited Data

The following must never be committed, embedded in a fixture, placed in a model
prompt, or printed as test evidence:

- customer, lead, prospect, staff, or operator personal data taken from real use;
- real phone numbers, email addresses, names, Page-scoped IDs, WhatsApp IDs,
  phone-number IDs, WABA IDs, Page IDs, app IDs, message IDs, or conversation IDs;
- access tokens, app secrets, API keys, verify tokens, tunnel credentials,
  passwords, authorization headers, cookies, session data, OTPs, or payment data;
- `.env` contents, password-manager exports, database dumps, backup archives,
  raw SQL parameter captures, or connection strings containing credentials;
- raw or lightly edited webhook payloads, chat exports, screenshots, recordings,
  browser storage, packet captures, or copied provider-console examples that
  contain account-specific values;
- production log lines, customer prompts, model responses, Manifest recordings,
  incident evidence, or support attachments;
- hashes, ciphertext, tokens, pseudonyms, or redacted fragments derived from any
  prohibited value.

When provenance is uncertain, treat the value as real, remove it, and recreate
the fixture from a blank synthetic template. If a secret may have entered Git,
stop normal work, rotate it outside Git, and follow an approved history-removal
procedure; merely deleting it in a later commit is insufficient.

## Logging Rules

Application and test logs use explicit allowlists. Safe fields are limited to
bounded operational metadata such as:

- event name, channel enum, status code, and bounded reason code;
- event or row count, duration, timestamp, and locally generated request
  reference;
- test name, sanitized outcome, and Git revision.

Logs must not contain message text, consent wording, external identities, raw
payloads, signatures, prompts, provider responses, SQL parameters, database URLs,
authorization context, tokens, or free-form exception detail from an external
system. Logging failures must not change webhook admission outcomes.

Negative tests may construct prohibited field names such as `authorization` or
`rawPayload` only with synthetic sentinel values and must assert that those fields
are rejected or absent from output.

## Evidence Rules

- Repository evidence records pass/fail outcomes, counts, bounded reason codes,
  timestamps with timezone, and Git revisions only.
- Diagnostic database queries select aggregates or enumerated states. They do not
  select message text, external identities, hashes, payloads, or credentials.
- Screenshots and recordings supplied during an operator test are not copied into
  the repository. Only sanitized conclusions may be recorded.
- Raw command output is not committed when it contains infrastructure or account
  identifiers. Summarize the verified property instead.
- Failure evidence follows the same rules as success evidence; debugging does not
  create an exception.

## Fixture Review Checklist

Before committing a fixture or evidence update, verify:

1. The data was authored from a blank synthetic template, not transformed from
   live data.
2. Every person, identifier, message, timestamp, and credential-shaped value is
   obviously synthetic or a documented safe test constant.
3. The fixture contains only fields required by the behavior under test.
4. Logs and assertions prove outcomes without exposing content or external IDs.
5. No screenshot, export, dump, recording, environment file, or raw payload was
   added.
6. `git diff --check`, formatting, tests, and a targeted secret-pattern scan pass.
7. The staged file list contains only the intended source, tests, and sanitized
   documentation.

No exception may authorize committing a real credential or live customer data.
Any other exception requires a written policy change and project-owner approval
before the artifact is created.

## Baseline Audit

The 2026-08-26 repository audit searched committed tests for long numeric values,
phone- and email-shaped values, URLs, database connections, credential-shaped
fields, raw-payload fields, and message content.

- Message and consent examples are explicitly synthetic.
- Provider identifiers use `TEST`, `synthetic`, fixed invented numeric values, or
  local UUIDs.
- Phone-shaped values use the non-routable `1555...` test family.
- Database connections use loopback test databases or `example.invalid` rejection
  cases.
- Credential-shaped values are nonfunctional `test_` or `synthetic_` sentinels.
- Prohibited field names appear only in negative tests that prove rejection or
  omission.
- The approved webhook hostname appears only in deployment contract and
  operations checks; no credential or account identifier accompanies it.
- No raw chat export, database dump, external payload fixture, screenshot, or
  recording is tracked.

This audit establishes the current baseline; it does not replace review of future
changes.
