# Plan: PROMPT_MATCH cleanup (done) + Deepgram captions for Canvas video submissions

## Part A — PROMPT_MATCH removal (completed)

- Removed `PROMPT_MATCH` / `n/a` logging and body-vs-metadata comparison from `resolvePromptRowFromWebmMetadata`.
- Dropped `comparableStable` from `computeAssignmentFallbackPromptRow` and removed `comparableStableFromSubmissionBodyJson` from `prompt-upload-payload.util.ts`.
- Kept encode/decode helpers and test-only `extractComparablePromptUploadFields` / `stableStringifyForPromptMatch` for `verify-webm-prompt-codec`.

---

## Part B — Deepgram transcription + WebVTT (implementation TBD)

### Goal

When a student submits a WebM for assignments that require **Sign-to-voice** (exact product flag TBD in config), start a **fully async** pipeline:

1. Send audio to Deepgram pre-recorded API (`DEEPGRAM_API_KEY` in env).
2. Obtain captions (WebVTT).
3. Persist captions and expose `captionsStatus: 'ready'` on the submission row used by grading.
4. In the **grading viewer only**: show a **CC** control when `captionsStatus === 'ready'`; no CC UI otherwise. No other grading-viewer changes.

### ffmpeg availability

- **Local dev:** `ffmpeg` / `ffprobe` present on PATH (verified: system ffmpeg 6.x).
- **Production (e.g. Render):** default Node runtimes often **do not** include ffmpeg. Before shipping, either:
  - add a **build step** that installs ffmpeg (apt, static binary, or custom Docker image), or
  - run caption mux / audio extract on a **worker** image that includes ffmpeg.
- **Action item:** confirm ffmpeg in the same environment that runs the API (or move CPU-heavy steps to a worker with ffmpeg).

### Architecture evaluation — is “mux WebVTT into WebM on Canvas” workable?

**Facts in this codebase today**

- Student video is uploaded to **Canvas** (`uploadVideo` → `initiateSubmissionFileUploadForUser` → attach). The **canonical bytes** live in Canvas Files / submission attachment, not in our Postgres blob store.
- Grading playback uses **Canvas file URLs** (often via `/api/prompt/video-proxy` with course token).
- There is **no** first-class “video submission” entity today—only `assignment_prompts`, `student_resets`, flashcard `assessment_sessions`, etc. **`captionsStatus` will require a new persisted model** (new table or new columns on a new entity keyed by `courseId` + `assignmentId` + `userId`).

**Re-muxing the WebM and replacing Canvas’ copy**

- Technically ffmpeg can **mux** WebVTT into WebM/Matroska as a subtitle track.
- **Operational gap:** after mux you must **put the new file back into Canvas** (new upload + attach or replace attachment). That implies:
  - download current WebM (already supported patterns),
  - extract audio / run Deepgram,
  - write VTT, mux,
  - **second Canvas upload** with correct permissions and submission wiring,
  - optional **delete or supersede** old file to avoid duplicate attachments.
- This is **high complexity** and permission-sensitive (teacher/student token, `as_user_id`, etc.). It can be done but should be a **deliberate phase** with API research (Canvas file replace vs new attachment).

**Lower-risk alternative (if Canvas replace is deferred)**

- Store **WebVTT in our DB** (or object storage) keyed by course/assignment/user; set `captionsStatus` when ready.
- Grading viewer uses `<video>` + `<track kind="subtitles" src="...">` pointing at **`GET /api/.../captions.vtt`** (auth same as proxy). **No second Canvas upload**, no binary rewrite of Canvas-owned WebM.
- If product mandate is strictly “VTT inside container,” treat **mux + Canvas replace** as phase 2 after ship-ready VTT delivery.

**Recommendation in plan:** implement **VTT storage + track URL** first unless Canvas replace is explicitly required for compliance; parallel-spike Canvas file replacement for true in-file storage.

### Async pipeline (non-blocking HTTP)

- `POST upload-video` (or a single “submission complete” hook) should **`void`** a service method (no `await` in controller) or enqueue a job.
- Use **structured logging** + retries; persist `captionsStatus`: `pending` → `ready` | `failed`.
- Prefer a small **DB-backed queue** or in-process queue with crash caveats; Redis/Bull only if you already run Redis.

### Deepgram integration sketch

1. **Trigger:** after successful Canvas attach (or on message from client) **only** when assignment requires Sign-to-voice (define field in `PutPromptConfigDto` / `PromptConfigJson`, e.g. `signToVoiceRequired: boolean` — **not present in repo today; add in spec**).
2. **Audio:** ffmpeg extract audio to wav/mp3/flac temp file (or stream) from downloaded WebM.
3. **API:** Deepgram pre-recorded transcribe with language/model appropriate for ASL gloss vs English (product decision).
4. **WebVTT:** map Deepgram segments to WebVTT cues; validate timestamps vs video duration.
5. **Persist:** save VTT + set `captionsStatus: 'ready'`; on error `failed` + log.

### API + UI changes (future PR)

- **DB migration:** new table e.g. `prompt_submission_captions` (`course_id`, `assignment_id`, `user_id`, `captions_status`, `vtt_text` or storage key, `updated_at`, optional `error_message`).
- **`getSubmissions` / `getMySubmission`:** include `captionsStatus` (and optionally `captionsUrl` for teacher-only signed URL).
- **`TeacherViewerPage`:** if `captionsStatus === 'ready'`, render CC toggle and attach `<track>`; **no other layout/behavior changes**.

### Testing gates

- ffmpeg available in target environment.
- Async: upload HTTP returns before Deepgram completes.
- Teacher sees CC only when status ready; student/teacher without captions unchanged.
- Failure path: `failed` does not break grading; no CC button.

---

## Summary

| Item | Status |
|------|--------|
| Remove PROMPT_MATCH | Done in code |
| ffmpeg on dev | Yes |
| ffmpeg on prod | Must be added or worker-based |
| Mux VTT into WebM | ffmpeg-capable; **Canvas replace** is the hard part |
| `captionsStatus` | Needs new persistence; no existing submission row |
| Sign-to-voice trigger | Config + product spec not in repo yet — add flag |
