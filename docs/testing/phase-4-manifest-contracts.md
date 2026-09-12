# Phase 4 Manifest Configuration And Contract Evidence

Date: 2026-09-12 (Asia/Dhaka)

## Scope

This checkpoint completes approved Phase 4 plan Task 13. It defines local,
fail-closed configuration, request construction, and structured-output
validation for the later Manifest client. It does not open a network connection,
read a real key, call Manifest or a provider, or change Manifest configuration.

## Implemented controls

- Configuration requires exact `model: "auto"`, a private `/v1` base URL, and
  explicit true attestations for recording-off, deletion/retention approval,
  provider allowlisting, Manifest limits within protected ceilings, and private
  routing. Missing or false attestations disable configuration.
- The API key may be blank for local contract work or a bounded nonblank secret.
  Errors contain setting names only and never return invalid values.
- Contact-window, global-day, concurrency, queue, timeout, output-token,
  cooldown, provider-attempt, architecture-provider, response-byte,
  context-item, and input-code-point ceilings are operator-supplied environment
  values. No operational value defaults in source. Intersection takes the
  smallest maximum and longest cooldown across policy, deployment, and verified
  Manifest sources.
- `.env.example` keeps every live-state attestation false because recording-off,
  approved provider/limit policy, deletion behavior, and the application-private
  route have not been externally verified. The model path therefore remains
  closed by default.
- Request construction accepts only process-issued successful sensitive-data
  inspections. It sends exactly one fixed system message and one JSON data
  message, `model: "auto"`, `stream: false`, and the supplied output-token
  ceiling. Context, approved facts, and total input are bounded.
- Request objects contain no tool, tool-choice, function, plugin, provider,
  fallback, or routing field. Prompt injection remains quoted user data and
  cannot modify the fixed system policy.
- Output parsing bounds UTF-8 bytes before JSON parsing and validates an exact
  six-field answer/escalation envelope. Rejections return only a closed reason,
  never the response body.
- Answer output must use the requested English/Bangla script, cite only supplied
  references, use only meaningful vocabulary and protected numeric/currency
  assertions found in cited facts, contain only approved cited URLs, and contain
  no sensitive value, tool claim, or external-action claim. Escalation output is
  content-free and requires human review.

## Test-first and validation evidence

- Initial focused execution failed all three suites because the planned model
  configuration, request, and output modules did not exist.
- The first implementation passed all 50 behavior cases. Strict type checking
  and lint then exposed unsafe unknown-array narrowing and tuple construction;
  those boundaries were corrected without suppressions.
- Self-review added failing-first cases for unrelated prose, negated facts, and
  a supported fact padded with an unsupported claim. The padded claim initially
  passed under percentage matching; grounding now rejects any meaningful answer
  token absent from cited published facts.
- Final focused suites: 54 tests across 3 files passed, including exact
  attestation/ceiling failures, stricter-source semantics, recursive forbidden-
  field inspection, sanitized input, injection isolation, strict envelopes,
  English/Bangla handling, references, grounding, secrets, URLs, actions, and
  byte bounds.
- `npm run check`: Phase 0 validator, formatting, lint, strict type checking,
  build, and 432 unit tests across 35 files passed.
- Task 13 changes no schema or persistence code. The unchanged latest complete
  guarded PostgreSQL result is Task 12's 316 tests across 23 files; it was not
  rerun or misrepresented as Task 13 execution.
- `git diff --check` and the changed-file credential-pattern scan passed before
  the checkpoint commit.

All fixtures are conspicuously synthetic and non-operational. No credential,
token, customer data, raw external message, provider body, external identity,
or secret value is included in this evidence.

## Deliberate non-claims

- No HTTP client exists at this checkpoint. Task 14 owns a single-attempt client
  and loopback fake.
- No live browser, Manifest, model, provider, Meta, n8n, tunnel, SSH, deployment,
  public-ingress, or production test was run.
- The false example attestations accurately preserve the known blockers:
  recording remains enabled, provider/limit policy is unapproved, and the
  application is not attached to Manifest's private Docker network.
