# Sign-to-voice: pre-upload captions + grading ffprobe + prefetch

Revised plan per product direction: **mux Deepgram WebVTT into the WebM on the server before any Canvas file upload**, then upload **once**. Remove all Canvas **media tracks** APIs and the post-upload caption pipeline (no re-download, no file swap, no `PUT media_tracks`).

---

## Preconditions (answered from code only)

### 1. Where the WebM exists before Canvas — insertion point for Deepgram + mux

In [`apps/api/src/prompt/prompt.service.ts`](apps/api/src/prompt/prompt.service.ts) `uploadVideo`:

- The recording arrives as `video.filePath` and/or `video.buffer` (already on server / in memory).
- Optional **PROMPT_DATA** remux runs first when `promptDataPayload` exists: materializes `inputPathForMux`, calls `muxWebmWithPromptDataTag`, and may set `uploadInput` to `{ filePath: muxed.outputPath, size }` (see ~2658–2686).
- **Canvas upload begins only at** `initiateSubmissionFileUploadForUser` (~2702), i.e. after local mux transforms.

**Correct insertion point:** after all **local** transforms that produce the final bytes to upload (after PROMPT_DATA mux if any, otherwise after writing buffer to temp if needed), and **immediately before** the block starting at ~2694 (`appendLtiLog('prompt-upload', 'uploadVideo: initiateSubmissionFileUploadForUser'...)`).

**Implementation note:** If both PROMPT_DATA and captions are required, prefer **one ffmpeg graph** or a defined order (e.g. PROMPT_DATA mux then caption mux on that output) to avoid double quality loss — plan-level detail for implementer.

**Deep linking gap:** [`submitDeepLink`](apps/api/src/prompt/prompt.service.ts) receives the WebM **on the server** but does **not** call `uploadVideo`; it builds an LTI response and relies on Canvas attaching the file. Any pre-upload caption work must also run **there** (shared helper) or deep-link submissions will lack embedded captions.

---

### 2. Can the existing ffprobe path extract subtitles “in the same pass”?

Today [`ffprobeWebmPromptDataJson`](apps/api/src/prompt/webm-prompt-metadata.util.ts) runs **only** `-show_format` and reads `format.tags.PROMPT_DATA` (base64 JSON). Subtitle tracks live under **streams**, not `format.tags`.

**Feasible “same pass” interpretation (matches intent, minimal download):**

- Extend ffprobe invocation to **one subprocess** with e.g. `-show_format -show_streams` (and optionally `-show_entries stream=index,codec_type,codec_name:stream_tags=language` etc.), parse JSON once, return:
  - `promptDataTag` (existing behavior), and
  - **whether** a subtitle/text stream exists and its **index** (or `none`).

**Full WebVTT cue text** is generally **not** in ffprobe JSON; extraction still needs **`ffmpeg`** (or `ffmpeg -i file -map 0:s:n -c copy out.vtt`) on the **same temp file** already held open in [`resolvePromptRowFromWebmMetadata`](apps/api/src/prompt/prompt.service.ts) — **no second download**, same `try` block before `dl.cleanup()` (~2478–2480).

So: **one ffprobe call extended** + **optional ffmpeg extract in the same read path** (not a second ffprobe for PROMPT_DATA).

---

### 3. Canvas media tracks API — code to remove entirely

| File | Remove |
|------|--------|
| [`apps/api/src/canvas/canvas.service.ts`](apps/api/src/canvas/canvas.service.ts) | `buildMediaAttachmentMediaTracksPutUrl`, `getMediaAttachment`, `putMediaAttachmentMediaTracks` (and any logs only used by them). |
| [`apps/api/src/prompt/sign-to-voice-caption.service.ts`](apps/api/src/prompt/sign-to-voice-caption.service.ts) | Post-upload pipeline: `runPipeline` download → WAV → Deepgram → Canvas calls; or **replace** service with a thin helper only if deep-link still needs async work without media_tracks. |
| Repo-wide | Grep for `media_tracks`, `getMediaAttachment`, `putMediaAttachmentMediaTracks`, `buildMediaAttachmentMediaTracksPutUrl` and delete all references. |

**Also remove / repurpose:** `scheduleAfterSuccessfulUpload` / `pollDeepLinkThenScheduleCaptions` triggers from [`prompt.service.ts`](apps/api/src/prompt/prompt.service.ts) that exist solely to run the post-upload caption job — once captions run inside `uploadVideo` / `submitDeepLink`, those schedules should go unless another use remains.

---

## Target upload pipeline (server)

1. Receive WebM (`uploadVideo` / shared helper).
2. Extract audio → Deepgram → WebVTT (reuse patterns from current [`sign-to-voice-caption.service.ts`](apps/api/src/prompt/sign-to-voice-caption.service.ts) + [`ffmpeg-captions.util.ts`](apps/api/src/prompt/ffmpeg-captions.util.ts)).
3. **ffmpeg** mux WebVTT as a **subtitle** track into the WebM (new util; gate on `signToVoiceRequired` + `DEEPGRAM_API_KEY` like today).
4. **Single** `initiateSubmissionFileUploadForUser` → `uploadFileToCanvas` → `attachFileToSubmission` with muxed bytes.

**Failure handling:** if Deepgram or mux fails, log (`sign-to-voice` / `webm-prompt` scopes) and upload **original** WebM (fail-open), unless product prefers hard-fail.

---

## Grading viewer — caption retrieval

- Extend [`resolvePromptRowFromWebmMetadata`](apps/api/src/prompt/prompt.service.ts) return shape (or parallel field) to include **optional `captionsVtt?: string`** populated in the same download + probe + extract `try` as PROMPT_DATA.
- Extend `getSubmissions` row merge to pass VTT to the client when present (new field on DTO), **or** keep one round-trip: teacher UI reads from prefetch cache only (see below).

**Web:** [`GradingVideoPlayer`](apps/web/src/components/GradingVideoPlayer.tsx) regains `<track>` + blob URL pattern; data supplied from parent state populated from API.

---

## Grading viewer — proactive prefetch

- On teacher grading load (`TeacherViewerPage` after `getSubmissions`), start **background** jobs (concurrency **3–5**, e.g. p-queue or a simple semaphore) that call a **single** API per submission user (or batch endpoint) returning `{ prompt..., captionsVtt? }` using the extended metadata path (no per-navigation fetch).
- Store results in `Map<userId, PrefetchedGradingMedia>` (or keyed by index) in React state; switching students uses cached VTT + cached prompt fields **instantly**.
- API options: (A) extend existing teacher-only route used for submissions list hydration, or (B) new `POST /api/prompt/prefetch-submission-metadata` with `{ userIds: string[] }` returning a map — implementer picks based on payload size.

---

## Implementation todos

1. **Shared pre-upload helper** — Deepgram + VTT mux; call from `uploadVideo` (pre-initiate) and `submitDeepLink` (pre-JWT).
2. **ffmpeg** — mux WebVTT into WebM; compose with PROMPT_DATA mux order.
3. **Remove** media tracks methods + post-upload `SignToVoiceCaptionService` pipeline wiring; adjust `prompt.module` if service deleted or minimized.
4. **ffprobe + ffmpeg extract** — extend `webm-prompt-metadata.util` / `resolvePromptRowFromWebmMetadata` for VTT; extend `getSubmissions` or add prefetch API.
5. **TeacherViewer** — prefetch pool (3–5), state cache, pass VTT into `GradingVideoPlayer`.
6. **QA** — upload + deep link + grading navigation; memory caps on parallel downloads.

---

## Supersedes

Earlier plan draft that described **post-upload** mux, **re-upload**, and **replace** flows is **obsolete** under this document.
