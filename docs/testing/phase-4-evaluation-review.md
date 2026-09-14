# Phase 4 Model Reply And Bilingual Evaluation Evidence

Date: 2026-09-14

## Scope

This checkpoint completes approved plan Task 17 with local TypeScript, a
structure-only Manifest fake, newly authored synthetic English/Bangla cases,
and isolated PostgreSQL databases. It made no live Manifest or provider
request, changed no Manifest setting or network, deployed nothing, used no
customer data, and did not touch Meta or production assets.

## Model reply composition

- A model decision is eligible only after the authoritative FAQ stage has
  stored a FAQ miss or ambiguity gap for the same applied customer event. An
  existing FAQ or safety draft bypasses allowance and Manifest.
- The service re-inspects current content, loads only currently effective
  approved bilingual FAQ/business facts, builds one bounded auto request with
  no tool/provider fields, and acquires one authoritative allowance lease.
- A structured answer is validated again against the exact supplied facts.
  Final PostgreSQL persistence locks the source, rechecks takeover, privacy,
  deletion, erasure, and retention, then revalidates every fact against the
  publication state effective at completion.
- A valid answer creates one model draft and model-fact links. Timeout,
  provider exhaustion, invalid output, unsupported claims, budget denial, and
  crash recovery create one reviewed deterministic safe draft plus one linked,
  content-free escalation. No failed path invents a business fact.
- Exact lease replay never calls Manifest twice. A lost active lease waits for
  expiry and then resolves to a safe database-failure draft. FAQ gaps remain as
  content-minimized proposal-only learning evidence.
- A regression found that a labelled test-card number without punctuation was
  not recognized. The recognizer and a permanent unit/integration case now
  fail that spelling closed before inference.

## Synthetic evaluation review

tests/fixtures/phase4-evaluation.json was authored from a blank synthetic
template. It contains no external source data, copied conversation, provider
capture, credential, account identifier, or real model response. The project
owner delegated local Phase 4 review decisions. These scripted fake outcomes
were self-reviewed under that delegation; they were not independently
human-scored. The stored reviewer reference is an opaque synthetic evidence
label, not a person or account.

| Measure | Result |
|---|---:|
| Total cases | 35 |
| English / Bangla | 18 / 17 |
| Self-reviewed scripted local-fake outcomes | 12 / 12 acceptable (100%) |
| Critical failures | 0 |
| AC-05 / AC-10 / AC-21 / AC-22 / AC-25 cases | 11 / 10 / 17 / 27 / 5 |

Coverage includes exact/paraphrased FAQ answers, FAQ precedence, grounded model
answers, explicit language switching, prompt injection, unsupported claims,
invalid output, timeout, provider exhaustion, contact/global/queue limits,
proposal-only learning, owner questions, and every sensitive class in the
approved design: password, authentication secret, OTP, recovery code, API key,
access token, cookie, session, payment card, bank account, private key,
credential file, and sensitive incident evidence.

The deterministic scorer requires:

- 100% for FAQ precedence, sensitive non-disclosure, no tools, safe failure,
  unsupported-claim rejection, language selection, and deterministic
  escalation;
- at least 90% acceptable self-reviewed scripted synthetic outcomes; and
- zero critical failures.

Negative tests prove one invariant failure, a sub-90% scripted rating, critical
failure, or non-synthetic provenance fails the gate. The fixture ratings are
declared local-fake observations, not independent generated-answer scoring.
This is local contract evidence only; human scoring and real-provider quality
remain required before test-asset promotion.

## Validation

- npm run check: PASS — Phase 0 validator, formatting, lint, strict type
  checking, 473 tests across 39 files, and build.
- Full guarded PostgreSQL run through infra/compose.test.yml: PASS — 345 tests
  across 27 files.
- Task 17 focused results: 43 unit tests across three files and 10 guarded
  PostgreSQL model-flow tests.
- The PostgreSQL flow proves customized output-token use, one call/draft,
  exact replay, timeout escalation, crash/expiry recovery, takeover/privacy/
  deletion precedence, late sensitive detection, retirement during inference,
  and direct-write grounding.

## Remaining external evidence

Manifest message-body recording is still reported enabled, and the application
has not joined Manifest's private Docker network. Provider allowlist/order,
limits, deletion behavior, recording-off state, private routing, and
real-provider English/Bangla quality remain unverified. The model path
therefore remains disabled for customer traffic. Those actions require their
later private deployment/test-asset gates.
