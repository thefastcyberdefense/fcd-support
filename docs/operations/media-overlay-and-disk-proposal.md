# Private Media OCR/STT Overlay & Separate Host Disk Analysis

## 1. Off-Host Pinned Image Builds & Synthetic Engine Verification (`linux/amd64`)

Built off-host (`--platform linux/x86_64`, `VCS_REF=4c4b93358094a88a4bed161435250e0c4bf5f822`):

| Service | Dockerfile | Local Digest / ID | Uncompressed Size | Runtime Footprint (`docker stats`) |
|---|---|---|---|---|
| `fcd-support-ocr` | `infra/media/Dockerfile.ocr` | `sha256:d2a7c5457d6c584721a0a8d71f988ddb688e0380ab7a8dda22c6a40e4d3257f0` (`466,415,911 B`) | `~444.8 MiB` | `39.12 MiB` / `512 MiB` (`0.00%` CPU idle, `8` PIDs) |
| `fcd-support-stt` | `infra/media/Dockerfile.stt` | `sha256:211b0b64beb1c75c257a2c9ec02abd7ddc4980f881b6368992b50ba0a3edaab7` (`1,258,139,717 B`) | `~1,199.9 MiB` | `36.04 MiB` / `1 GiB` (`0.01%` CPU idle, `12` PIDs) |
| **Combined Total** | — | — | **`1,724,555,628 B` (`~1,644.7 MiB` / `1.61 GiB`)** | Fits within `1.5 GiB` + `2.0` vCPU caps (`0.5` + `1.5` CPU) |

### Live Container Smoke Tests (Real Tesseract `5.3.0` + `ffmpeg` + `whisper.cpp v1.9.5` `ggml-base.bin`)
- **OCR Health (`GET /health`)**: `200` (`296ms` warm path) — `{"ok":true,"service":"ocr"}`.
- **English PNG (`POST /extract`)**: `200` (`296.4ms`) — `{"status":"extracted","text":"Compliance & Governance advisory and guidance","language":"en","confidence":0.9513}`.
- **Bangla PNG (`POST /extract`)**: `200` (`284.7ms`) — `{"status":"extracted","text":"কমপ্লায়েন্স ও Wo পরামর্শ ওংড","language":"bn","confidence":0.7996}` (Tesseract `eng+ben` extracted recognizable Bangla words and classified `language: "bn"`; ligatures showed partial ASCII-noise interference under `-l eng+ben`).
- **Visual-Only PNG (`POST /extract`)**: `200` (`211.9ms`) — `{"status":"visual_only","hasVisualContent":true,"reasonCode":"visual_interpretation_deferred"}`.
- **STT Health (`GET /health`)**: `200` — `{"ok":true,"service":"stt"}`.
- **English Spoken WAV (`POST /transcribe`)**: `200` (`4215.3ms`) — `{"status":"extracted","text":"Please explain compliance and governance advisory services.","language":"en","confidence":0.9}`.
- **English Ogg Opus Voice Note (`POST /transcribe`)**: `200` (`4151.4ms`) — `{"status":"extracted","text":"Please explain compliance and governance advisory services.","language":"en","confidence":0.9}`.
- **Silent PCM WAV (`POST /transcribe`)**: `200` (`3986.9ms`) — `{"status":"unclear","reasonCode":"stt_empty_text"}`.
- *(Live spoken Bangla audio sample was not synthesized off-host and remains pending for device/audio verification.)*

## 2. Deployment Integration & Clean Rollback

- Opt-in is controlled in `operations.env` by `FCD_MEDIA_ENABLED=true`, `FCD_OCR_IMAGE=<sha256:...>`, `FCD_STT_IMAGE=<sha256:...>`, and per-role read-only secrets `${FCD_SECRET_ROOT}/reply/reply-meta-whatsapp-token` + `${FCD_SECRET_ROOT}/reply/reply-meta-page-token`.
- `scripts/operations-common.sh`, `operations-controller.sh`, `operations-startup.sh`, `operations-runtime-host.sh`, `operations-drain.sh`, `operations-containment.sh`, `src/operations/compose-contract.ts`, and `src/operations/runtime-host.ts` enforce:
  - `private-enabled` mode required whenever `FCD_MEDIA_ENABLED=true`;
  - non-root `node`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `/tmp` `noexec` tmpfs, zero ports/secrets/volumes on `ocr`/`stt`;
  - internal `media_internal` network + scoped `provider_egress` on `fcd-support-reply` + `ocrHttp`/`sttHttp` runtime probes.
- **Rollback:** Set `FCD_MEDIA_ENABLED=false` (or omit it / deploy `private-disabled`) and re-run deploy/rollback (`operations-drain.sh` cleanly stops and removes `fcd-support-ocr` & `fcd-support-stt` along with `reply`, restoring the 5-container or 4-container topology cleanly).

## 3. Separate Host Headroom & Retained Image Cleanup Analysis (`192.168.10.40`)

**Image cleanup is explicitly excluded from the Media PR and requires separate operator approval.**

Observed on `192.168.10.40` (`2026-11-21`):
- `df -Pm /`: `117,301 MiB` total, `99,257 MiB` used, **`12,452 MiB` free** (`89%`) — only **`164 MiB` above the `12,288 MiB` (`12 GiB`) operational floor**.
- Loading both off-host images (`~1,645 MiB`) directly onto `192.168.10.40` without prior cleanup would drop free space to `~10,807 MiB`, breaching the `12 GiB` floor.
- `docker system df`: `61` images (`37.71 GB`, **`15.63 GB` reclaimable**), `318` build-cache entries (`11.15 GB`, **`4.332 GB` reclaimable**).
- `/home/redwan/fcd-support-host-test-v9-4c4b933/state/retained-*` references **only** `4c4b93358094a88a4bed161435250e0c4bf5f822`.
- Superseded unretained FCD test-slot images on host include `v1` (`c2d8225`: `application` `383 MB`, `postgres` `644 MB`), `v7` (`cc017d1`: `application` `389 MB`, `operations` `908 MB`, `postgres` `644 MB`), and `v8` (`4e80302`: `application` `389 MB`, `operations` `908 MB`, `postgres` `644 MB`) (`~4.9 GB` combined across shared layers), alongside stale dangling/unreferenced Docker build cache and unrelated stopped-project images (`browserless/chrome` `4.51 GB`, older `n8n` `2.48 GB`/`2.26 GB`, `hindsight` `6.4 GB`). Reclaim only after separate owner sign-off verifying no parallel recovery slot depends on them.
