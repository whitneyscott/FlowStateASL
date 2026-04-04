---
name: ""
overview: ""
todos: []
isProject: false
---

# Prompt Manager: SproutVideo Fallback for Local Dev (Revised)

## User feedback incorporated

1. **TTL:** Store entries have been expiring in minutes, not 24 hours. Extend to a true 24h (and fix any cause of early expiry). **The user has stated repeatedly that they are NOT restarting the process** — so the cause is not app restart.
2. **Folder:** Do not find folder by name or cache folder id in memory. **Look in .env first** (e.g. `SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID`) — fastest, no Canvas API. If missing, then check the **Prompt Manager Settings assignment description** (slower, but works when the app has not restarted after initially creating the folder). Create the folder when the teacher first saves config; store the id in the Settings assignment so it persists; user can optionally add that id to .env for faster lookups.

---

## 0. Canvas documentation and why the video disappears in minutes

**Canvas docs checked:** Official Canvas/Instructure documentation (LTI Resource Links, Deep Linking, content items, submission attachments, file URLs) was reviewed. **There is no documented expiration time for LTI submission or content-item URLs.** The LTI Resource Links API describes a persistent `canvas_launch_url` and `url` with no expiry. Community posts mention progress-object or file download URLs possibly expiring, but no definitive LTI submission URL expiry is documented.

**Cause in our code:** The video is served at `GET /api/prompt/submission/:token`. That route is protected by **LtiLaunchGuard**, which requires `**req.session.ltiContext`**. The session is populated when the frontend calls `GET /api/lti/context?lti_token=XXX`; that call **consumes** the one-time `lti_token` from `apps/api/src/lti/lti-token.store.ts`. **That token has a TTL of 1 minute** (`TTL_MS = 60_000`). So:

- If the user does not hit `/api/lti/context` within 1 minute of launch (e.g. slow load, tab in background, or they open the viewer later from a bookmarked URL that still has `lti_token` in the query), the token is already expired when they do call it → session never gets `ltiContext`.
- Thereafter, any request that requires LtiLaunchGuard (including the video request) fails with **401** because `req.session.ltiContext` is missing. The video container then appears empty even though the file may still be in our deep-link file store (24h TTL).

So the "video expiring in minutes" is likely **not** the file store expiring; it is the **LTI token (1 min) expiring** before the session is hydrated, or the session never being hydrated, so the **video request returns 401** and the player shows nothing.

**Fixes:**

1. **Extend LTI token TTL** in `apps/api/src/lti/lti-token.store.ts` from 1 minute to **24 hours** (or at least 60 minutes), so the frontend has a long window to call `/api/lti/context` and set `ltiContext` in the session.
2. **Optionally allow token-only access for the video endpoint:** Make `GET /api/prompt/submission/:token` work **without** requiring `req.session.ltiContext` (e.g. skip LtiLaunchGuard for this route, or use a separate guard that only validates that the token exists in the file store). The submission token is a 48-hex unguessable value, so serving the video by token alone is acceptable. Then the video will load even if the session has expired or was never set.

---

## 1. Extend in-memory store TTL to 24 hours

**Current state:** `apps/api/src/lti/lti-deep-link-file.store.ts` defines `TTL_MS = 24 * 60 * 60 * 1000` (24 hours) for both the file store and the token-by-user map. That is correct for the **video buffer** itself.

**Actions:**

- Keep file store TTL at 24 hours; ensure no other code path uses a shorter expiry for the same store.
- Optionally make it configurable via env (e.g. `DEEP_LINK_FILE_STORE_TTL_HOURS=24`), default 24.
- **Separately:** extend the **LTI token** TTL in `apps/api/src/lti/lti-token.store.ts` from 1 minute to 24 hours (see section 0).

---

## 2. SproutVideo folder: create once; look up from .env first, then Prompt Manager Settings

**No repeated lookups by name; no in-memory folder cache.** Resolve the folder id in two steps for speed:

- **First:** Check **.env** for `SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID` (or similar). If set, use it — no Canvas API call, much faster.
- **If missing from .env:** Read the **Prompt Manager Settings assignment** description (Canvas API). The assignment (title "Prompt Manager Settings") stores a JSON blob in its description (`readPromptManagerSettingsBlob`). Extend that blob with `sproutPromptSubmissionsFolderId?: string`. Slower, but works when the app has not restarted after the folder was first created and the id was written to the blob.

**When to create the folder:**

- When the teacher saves config for an assignment (**putConfig**), and we need the folder id but it's in neither .env nor the Settings blob:
  - Call SproutVideo: create folder with name "PromptSubmissions" (POST `/v1/folders` with `name: "PromptSubmissions"`).
  - Store the returned id in the **Prompt Manager Settings assignment description** (so it persists across restarts). Optionally document for the user that they can add the same id to .env for faster lookups (the app does not write .env).
  - Preserve `sproutPromptSubmissionsFolderId` on every subsequent putConfig so we don't overwrite it.

**When to use the folder id:**

- On student submit (dev only): resolve folder id via **env first, then Settings blob**; upload to SproutVideo with that `folder_id`. If still missing, create folder and write id to Settings blob (and optionally skip upload this time or retry).
- When building fallback URL or serving fallback: no folder lookup needed for playback; folder is only for upload. Playback uses the stored SproutVideo video URL (in fallback store or comment).

So: **resolve folder id from .env first (fast), then from Prompt Manager Settings assignment (slower, no Canvas call if env is set).** Create folder when missing and persist id in Settings assignment; user can add that id to .env for speed.

---

## 3. Fallback store and flow (unchanged in spirit)

- **On submit (dev only):** In `submitDeepLink`, resolve folder id (env first, then Prompt Manager Settings), upload the same buffer to SproutVideo with that `folder_id`, get watch/embed URL, store it in a small fallback store keyed by `(courseId, assignmentId, userId)` with TTL (e.g. 24h).
- **On view:** When resolving `videoUrl` for an ltiResourceLink submission, if the in-memory file is missing for that token, use the stored SproutVideo URL (e.g. `fallbackVideoUrl`). Viewer tries in-memory first; on failure, show SproutVideo (iframe).
- **Optional:** Add SproutVideo link as a submission comment (e.g. via client-triggered delayed API call) so it appears in SpeedGrader.

---

## 4. Implementation checklist


| Item                                          | Action                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LTI token TTL**                             | In `apps/api/src/lti/lti-token.store.ts`, change `TTL_MS` from `60_000` (1 min) to `24 * 60 * 60 * 1000` (24h) so the frontend has time to call `/api/lti/context` and set session.                                                                        |
| **Video endpoint without session (optional)** | Allow `GET /api/prompt/submission/:token` to serve video when the token exists in the file store even if `req.session.ltiContext` is missing (e.g. exempt this route from LtiLaunchGuard or use a token-only guard).                                       |
| TTL (file store)                              | Ensure `apps/api/src/lti/lti-deep-link-file.store.ts` uses 24h everywhere; optionally env `DEEP_LINK_FILE_STORE_TTL_HOURS` (default 24).                                                                                                                   |
| Blob shape                                    | Add `sproutPromptSubmissionsFolderId?: string` to `PromptManagerSettingsBlob` in `apps/api/src/prompt/prompt.service.ts`.                                                                                                                                  |
| putConfig                                     | In putConfig, when folder id is needed and missing from both env and blob: call SproutVideo create folder "PromptSubmissions", then write that id into the Settings assignment description and preserve it on all future writes.                           |
| **.env placeholder**                          | When executing the plan: add to `**.env`** a line with the variable name and a placeholder value so the variable name is explicit, e.g. `SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID=`. User replaces with real SproutVideo folder id when they have it.           |
| Read folder id                                | Helper (or inline): get folder id **from env first** (e.g. `SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID`); if missing, then from `readPromptManagerSettingsBlob` → `sproutPromptSubmissionsFolderId`. Use in submit path when uploading to SproutVideo (dev only). |
| SproutVideo service                           | Add `createFolder(name)`, `uploadVideo(buffer, filename, folderId?)` in `apps/api/src/sproutvideo/sproutvideo.service.ts`. No list-by-name on every request.                                                                                               |
| submitDeepLink                                | Dev only: resolve folder id (env first, then Settings blob); upload buffer to SproutVideo; store returned embed/watch URL in fallback store keyed by (course, assignment, user).                                                                           |
| getSubmissions                                | When in-memory file is missing for token, set `fallbackVideoUrl` from fallback store.                                                                                                                                                                      |
| Viewer                                        | When video fails and `fallbackVideoUrl` exists, show iframe with SproutVideo URL.                                                                                                                                                                          |


---

## 5. Files to touch (summary)

- **.env** — When executing: add a line with the env variable name and a placeholder value so you don't have to guess the name, e.g. `SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID=`. Replace with the real SproutVideo folder id when you have it.
- **apps/api/src/lti/lti-token.store.ts** — Extend TTL from 1 minute to 24 hours so session can be hydrated long after launch.
- **apps/api/src/prompt/prompt.controller.ts** — (Optional) Exempt `GET submission/:token` from LtiLaunchGuard so the video loads by token alone when session has no ltiContext.
- **apps/api/src/lti/lti-deep-link-file.store.ts** — Keep TTL 24h; optionally read from env.
- **apps/api/src/prompt/prompt.service.ts** — Extend `PromptManagerSettingsBlob` with `sproutPromptSubmissionsFolderId`; in putConfig, ensure folder exists when missing (from both env and blob) and write id to blob; in submitDeepLink (dev), resolve folder id (env first, then blob), upload to SproutVideo, store fallback URL; in getSubmissions, use fallback when file missing.
- **apps/api/src/sproutvideo/sproutvideo.service.ts** — Add `createFolder(name)`, `uploadVideo(buffer, filename, folderId?)`.
- **Prompt module** — Import SproutVideo module; add fallback store (in-memory, keyed by course/assignment/user).
- **Canvas** — Already has `updateAssignmentDescription`; payload will now include `sproutPromptSubmissionsFolderId` when set.
- **Frontend** — Add `fallbackVideoUrl` to submission type; in TeacherViewerPage, show SproutVideo iframe when primary video fails and fallback is present.

---

## 6. Why this fixes the issues

- **Canvas + our TTL:** Canvas docs do not define an expiration for LTI submission URLs. In our app, the deep-link **file** store already uses 24h. The "video gone in minutes" behavior (without restart) is addressed by extending the **LTI token** TTL from 1 minute to 24 hours and/or allowing the submission video endpoint to serve by token only, so the video loads even when the session has no `ltiContext`.
- **Folder id: .env first, then Settings assignment:** Check `.env` (e.g. `SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID`) first — no Canvas API, fastest. If missing, read from Prompt Manager Settings assignment description (slower, but works when the app hasn't restarted after creating the folder). Folder is created once when the teacher configures an assignment and the id is missing; id is stored in the Settings blob so it persists; user can add the same id to .env for faster lookups.

