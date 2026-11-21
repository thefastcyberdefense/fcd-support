# Private Media OCR/STT Overlay & Separate Host Disk Analysis

## 1. Off-Host Pinned Image Builds & Synthetic Engine Verification (`linux/amd64`)

Initial baseline built off-host (`--platform linux/x86_64`, `VCS_REF=4c4b93358094a88a4bed161435250e0c4bf5f822`; rebuild pinned to the accepted PR #42 head commit before host transfer):

| Service | Dockerfile | Local Digest / ID | Uncompressed Size | Runtime Footprint (`docker stats`) |
|---|---|---|---|---|
| `fcd-support-ocr` | `infra/media/Dockerfile.ocr` | `sha256:d2a7c5457d6c584721a0a8d71f988ddb688e0380ab7a8dda22c6a40e4d3257f0` (`466,415,911 B`) | `~444.8 MiB` | `39.12 MiB` / `512 MiB` (`0.00%` CPU idle, `8` PIDs) |
| `fcd-support-stt` | `infra/media/Dockerfile.stt` | `sha256:211b0b64beb1c75c257a2c9ec02abd7ddc4980f881b6368992b50ba0a3edaab7` (`1,258,139,717 B`) | `~1,199.9 MiB` | `36.04 MiB` / `1 GiB` (`0.01%` CPU idle, `12` PIDs) |
| **Combined Total** | — | — | **`1,724,555,628 B` (`~1,644.7 MiB` / `1.61 GiB`)** | Fits within `1.5 GiB` + `2.0` vCPU caps (`0.5` + `1.5` CPU) |

### Live Container Smoke Tests (Real Tesseract `5.3.0` + `ffmpeg` + `whisper.cpp v1.9.5` `ggml-base.bin`)
- **OCR Health (`GET /health`)**: `200` — `{"ok":true,"service":"ocr"}`.
- **English PNG (`POST /extract`)**: `200` — `{"status":"extracted","text":"Compliance & Governance advisory and guidance","language":"en","confidence":0.9513}` (measured directly from Tesseract TSV per-word confidences; `confidence` is omitted if TSV provides no word scores, never hardcoded).
- **Bangla PNG (`POST /extract`, HarfBuzz-shaped Chromium/Edge PNG & GDI PNG)**:
  - HarfBuzz-shaped Bangla PNG (`bn-harfbuzz.png`, `48px` Nirmala UI) -> `কমপ্লায়েন্ন ও গভর্থ্যান্ পরামর্শ ও নির্দেশনা` (`confidence: 0.8092`, classified `language: "bn"` across `eng+ben`, `ben+eng`, and `ben`; small conjunct confusions `ন্স`->`ন্ন` / `র্ন্যান্স`->`র্থ্যান্`). Scored in `docs/testing/phase-7-bilingual-scoring-packet.md`.
  - GDI `System.Drawing` PNG (`bn-large.png`) -> `কমপ্লায়েন্স ও Wo পরামর্শ ওংড` (`confidence: 0.7996`).
- **Visual-Only PNG (`POST /extract`)**: `200` — `{"status":"visual_only","hasVisualContent":true,"reasonCode":"visual_interpretation_deferred"}`.
- **Corrupt/Poor OCR & Escalation**: Corrupt/non-image bytes -> `visual_only` or `500 {"status":"failed","reasonCode":"ocr_execution_failed"}` -> `PrivateMediaProcessor` escalates (`visual_media_deferred` / `media_extraction_failed`); low confidence `< 0.55` -> `unclear` (`ocr_low_confidence`) -> escalates (`unclear_media`).
- **STT Health (`GET /health`)**: `200` — `{"ok":true,"service":"stt"}`.
- **Meaningful Confidence & Engine Marker Rejection**:
  - `runWhisperStt` runs `whisper-cli -ojf` (`--output-json-full`) and computes `confidence` as the mean of non-special token probabilities (`tokens[].p`, `0..1`), omitting `confidence` altogether when no token probability measurement is provided (never reporting a hardcoded `0.9`).
  - `stripSttEngineMarkers` strips silence and non-speech markers (`[BLANK_AUDIO]`, `(blank audio)`, `[SILENCE]`, `[INAUDIBLE]`, `[MUSIC]`, `[NOISE]`, `[_BEG_]`, and bracketed/parenthesized non-speech tags) before checking minimum alphanumeric length (`3`), so silent or non-speech audio returns `200 {"status":"unclear","reasonCode":"stt_empty_text"}` and safely escalates (`unclear_media`).
- **English Spoken WAV & Ogg Opus Voice Note (`POST /transcribe`)**: `200` — `{"status":"extracted","text":"Please explain compliance and governance advisory services.","language":"en","confidence":<measured_token_p>}`.
- **Silent PCM WAV (`POST /transcribe`)**: `200` — `{"status":"unclear","reasonCode":"stt_empty_text"}` (`[BLANK_AUDIO]` rejected).
- **Bangla Spoken Audio Hold (`bn-BD-NabanitaNeural` MP3 & Ogg Opus, `"আপনারা কী কী ধরনের সাইবার নিরাপত্তা সেবা প্রদান করেন?"`)**:
  - Live `whisper-cli` (`ggml-base.bin`) emitted Urdu/Arabic script phonetic approximations (`"اپنا رکی..."`) with both `-l auto` and explicit `-l bn`.
  - `stt-server.ts` fails closed on script mismatch (`{"status":"unclear","reasonCode":"stt_script_mismatch"}`) and also holds automated Bangla voice by default (`STT_ENABLE_BANGLA=false` -> `{"status":"unclear","reasonCode":"stt_bangla_held"}`) so Bangla voice notes always escalate safely (`unclear_media`) until a dedicated Bengali ASR model upgrade passes independent scoring.

## 2. Deployment Integration & Clean Rollback

- Opt-in is controlled in `operations.env` by `FCD_MEDIA_ENABLED=true`, `FCD_OCR_IMAGE=<sha256:...>`, `FCD_STT_IMAGE=<sha256:...>`, and per-role read-only secrets `${FCD_SECRET_ROOT}/reply/reply-meta-whatsapp-token` + `${FCD_SECRET_ROOT}/reply/reply-meta-page-token`.
- `scripts/operations-common.sh`, `operations-controller.sh`, `operations-startup.sh`, `operations-runtime-host.sh`, `operations-drain.sh`, `operations-containment.sh`, `src/operations/compose-contract.ts`, and `src/operations/runtime-host.ts` enforce:
  - `private-enabled` mode required whenever `FCD_MEDIA_ENABLED=true`;
  - non-root `node`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `/tmp` `noexec` tmpfs, zero ports/secrets/volumes on `ocr`/`stt`;
  - internal `media_internal` network + scoped `provider_egress` on `fcd-support-reply` + `ocrHttp`/`sttHttp` runtime probes.
- **Rollback:** Set `FCD_MEDIA_ENABLED=false` (or omit it / deploy `private-disabled`) and re-run deploy/rollback (`operations-drain.sh` cleanly stops and removes `fcd-support-ocr` & `fcd-support-stt` along with `reply`, restoring the 5-container or 4-container topology cleanly).

### Concise Rollout Plan (Post-PR Acceptance; Storage Cleanup Approved Separately)

1. **Separate Host Disk Cleanup Decision:** Do not prune or load images until the owner approves reclaiming superseded `v1`/`v7`/`v8` or stopped-project images/build cache on `192.168.10.40` (current headroom is `~164 MiB` above the `12,288 MiB` floor, whereas loading both media images adds `~1,645 MiB`).
2. **Stage Integrated Pinned Images:** After media PR acceptance, build `infra/media/Dockerfile.ocr` and `infra/media/Dockerfile.stt` (`--platform linux/amd64`, `--build-arg VCS_REF=<accepted_commit_sha>`), export compressed tarballs, transfer to `192.168.10.40`, `docker load`, and verify exact immutable `sha256:` image IDs and `org.opencontainers.image.revision` labels match.
3. **Stage Per-Role Meta Media Fetch Secrets (`0600`):** Write `${FCD_SECRET_ROOT}/reply/reply-meta-whatsapp-token` and `${FCD_SECRET_ROOT}/reply/reply-meta-page-token` root/operator-readable only, mounted read-only into `fcd-support-reply` only (never into `ocr` or `stt`).
4. **Enable & Deploy Private Overlay:** Set `FCD_MEDIA_ENABLED=true`, `FCD_OCR_IMAGE=<pinned-sha256>`, and `FCD_STT_IMAGE=<pinned-sha256>` in `operations.env` under `deployment.lock`, run deploy with `--mode private-enabled`, and verify `fcd-support-ocr` + `fcd-support-stt` healthy (`GET /health` over internal `media_internal`, zero published ports, non-root `node`, `read_only: true`, `cap_drop: [ALL]`) plus `verify-runtime.sh --mode private-enabled` and synthetic OCR/STT + unsafe-extraction escalation smoke checks.
5. **Rollback Path:** Remove/set `FCD_MEDIA_ENABLED=false` (or deploy `private-disabled`) and re-run deploy so `operations-drain.sh` removes `fcd-support-ocr` and `fcd-support-stt` without touching PostgreSQL or retained checkpoints.

## 3. Separate Host Headroom & Retained Image Cleanup Analysis (`192.168.10.40`)

**Image cleanup is explicitly excluded from the Media PR and requires separate operator approval.**

### A. Measured Rollout Footprint vs. Current Host Disk Headroom (`2026-11-21`)
- **Host Root Filesystem (`df -Pm /`):** `117,301 MiB` total, `99,269 MiB` used, **`12,440 MiB` free (`89%`)** — only **`152 MiB` above the `12,288 MiB` (`12 GiB`) operational floor**.
- **Measured Media Rollout Footprint:**
  - `fcd-support-ocr` image: `466,415,918 B` (`~444.8 MiB` uncompressed; `34.02 MiB` idle RSS / `512 MiB` cap; `64 MiB` tmpfs; `0.5` vCPU; `7` PIDs).
  - `fcd-support-stt` image: `1,258,146,626 B` (`~1,199.9 MiB` uncompressed; `32.25 MiB` idle RSS / `1,024 MiB` cap; `128 MiB` tmpfs; `1.5` vCPU; `7` PIDs).
  - **Combined disk footprint:** **`1,724,562,544 B` (`~1,644.7 MiB` / `1.61 GiB`)** (plus temporary tarball staging during `docker load` if not streamed via `ssh ... docker load`).
  - Loading both images directly onto `192.168.10.40` without prior cleanup would reduce free space from `12,440 MiB` to **`~10,795 MiB`** (`1,493 MiB` below the `12,288 MiB` operational floor).

### B. Audit of Retained Recovery References Across Slot Directories (`v1`–`v9`)
- While `/home/redwan/fcd-support-host-test-v9-4c4b933/state/retained-4c4b93358094a88a4bed161435250e0c4bf5f822.record` references only `4c4b93358094a88a4bed161435250e0c4bf5f822` (`application` `sha256:9732b77d...`, `operations` `sha256:af84625a...`, `postgres` `sha256:38d0435f...`), earlier host-test slot directories under `/home/redwan/fcd-support-host-test-v*` still hold their own `state/retained-*.record` and `restore-*.intent` files:
  - **`v7` (`/home/redwan/fcd-support-host-test-v7-cc017d1/state/retained-cc017d19c6d12324902ecf50b40dc7ae3234eb6e.record`):** references `BUNDLE_APPLICATION_IMAGE=sha256:ad53b7ba463a40fd5dab4dd609571e4ea351b4ae7bf6e626b768a9e8a4de5639`, `BUNDLE_OPERATIONS_IMAGE=sha256:28d08262c508324521a97bb6fab3be638a92b0e6b4d62391c1b5fc3f28463d2b`, `BUNDLE_POSTGRES_IMAGE=sha256:269ae769d70be7d48ebdc38f6e527ce81fd3fa6c6a9e9f9b2b173e025c28ba7f` (`~1.93 GB` nominal).
  - **`v8` (`/home/redwan/fcd-support-host-test-v8-4e80302/state/retained-4e80302f78ff698ff7dc332809a71ab09b59ba61.record` + `restore-14bee83f275ca953e8c3a6b2582b0478.intent`):** references `BUNDLE_APPLICATION_IMAGE=sha256:66f9d059b3241ec130e7b3a5920c2b9d6ac791cdcd69623cdda63d55f83df917`, `BUNDLE_OPERATIONS_IMAGE=sha256:c3ca513f0fbcc065729ad6565e7378a5582a733f1143077e76bfcceb097cf9bb`, `BUNDLE_POSTGRES_IMAGE=sha256:f36e9076df2040a6649d4aba00c3e79c58553f1cda6dd5dac8ac1ef347fc3224` (`~1.93 GB` nominal).
  - **`v1`–`v6` (`/home/redwan/fcd-support-host-test-v1-c2d8225` .. `v6-3fadcda`):** each has a historical `state/retained-*.record` (`c2d8225`, `75b906b`, `86b9447`, `0a5f2ab`, `0c7a77a`, `3fadcda`); note `v1` containers are still running/restarting on the host, while `v2`–`v6` images were already pruned during earlier iterations.

### C. Separate Two-Tier Storage Reclamation Proposal (Requires Explicit Owner Sign-Off)
1. **Option 1 — Reclaim Build Cache Only (Preserves `v7`, `v8`, and `v9` Retained Recovery Images Intact):**
   - Run `docker builder prune --filter "until=24h" -f` to reclaim **`~4.33 GB` (`~4,130 MiB`)** of unreferenced build cache without touching any `v7`, `v8`, or `v9` container images or `retained-*.record` bindings.
   - Expected `/` free space after build-cache prune: `~16,570 MiB` (`~14,925 MiB` after loading both media images — **`~2,637 MiB` above the `12,288 MiB` floor**).
2. **Option 2 — Decommission Superseded `v7`/`v8` (and/or `v1`) Recovery Slots:**
   - Only if the owner confirms `v7` (`cc017d1`) and `v8` (`4e80302`, including `restore-14bee83f275ca953e8c3a6b2582b0478.intent`) are no longer needed as rollback targets now that `v9` (`4c4b933`, `restore-7d109a4c...record`) is verified: archive `/home/redwan/fcd-support-host-test-v7-cc017d1/state` and `/home/redwan/fcd-support-host-test-v8-4e80302/state` first, then remove the six `v7`/`v8` images (`~3.86 GB` nominal).
