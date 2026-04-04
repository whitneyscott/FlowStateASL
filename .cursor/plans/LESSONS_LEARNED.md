# ASL Express – LTI 1.3 Deep Linking: Lessons Learned
## Homework Submission Flow — March 13, 2026
*A day that felt like Alice in Wonderland*

---

## Overview

This document captures every significant problem encountered and solved during the implementation of the LTI 1.3 Deep Linking `homework_submission` flow for ASL Express Prompt Manager. The session was extraordinarily difficult, involving multiple dead ends, environment-specific gotchas, and cascading issues where fixing one problem revealed the next.

**Final result:** Student records video → submits via Deep Linking → Canvas fetches and stores the file permanently → Teacher opens grading viewer → video plays inline. Server restarts do not affect stored submissions.

---

## Lesson 1: Canvas Blocks Private IP Addresses (CanvasHttp::InsecureUriError)

**Problem:** The Deep Linking response JWT was accepted (HTTP 200) but Canvas's background job (`SubmitHomeworkService::SubmitWorker`) silently failed to fetch the video file. No obvious error in canvas-web-1 logs.

**Root Cause:** Canvas's `CanvasHttp` client blocks all private IP ranges (`172.16.0.0/12`, `10.x.x.x`, `192.168.x.x`) with `InsecureUriError`. In local Docker development the API is at `172.22.0.1:3000` — a private IP Canvas refuses to fetch from.

**Fix:** 
- For JWKS: embed `public_jwk` directly in the Developer Key JSON. Do not use `public_jwk_url` in local dev.
- For file fetching: use `ltiResourceLink` in development, `file` content item only in production where a real public URL exists.
- For local testing of the `file` path: use a tunnel (ngrok or cloudflared).

**Where to look when this happens:** `canvas-jobs-1` logs, not `canvas-web-1`. Filter with:
```bash
docker logs canvas-jobs-1 2>&1 | grep -E "(SubmitWorker|InsecureUri|deep-link-file)" | tail -10
```

**Rule:** Never use `public_jwk_url` or `file` content item URLs pointing to private IPs in local Docker Canvas. The failure is silent in the web logs.

---

## Lesson 2: Canvas Paste JSON Does Not Clear Existing Fields

**Problem:** After re-importing the Developer Key JSON with `public_jwk` embedded and `public_jwk_url` absent, Canvas was still trying to fetch the JWKS from the old private IP URL and returning 400 on Deep Linking responses.

**Root Cause:** Canvas's "Paste JSON" import only sets fields that are present in the JSON. It does not null out fields that were previously set. `public_jwk_url` was still in the database from a previous import.

**Fix:** After every Developer Key re-import, explicitly clear the field via Rails runner:
```bash
docker exec -it canvas-web-1 rails runner 'k = DeveloperKey.find(10000000000008); k.public_jwk_url = nil; k.save; puts k.public_jwk_url.inspect'
```
Expected output: `nil`

**Verify the key is correctly stored:**
```bash
docker exec -it canvas-web-1 rails runner 'puts DeveloperKey.find(10000000000008).public_jwk_url.inspect; puts DeveloperKey.find(10000000000008).public_jwk.inspect'
```

**Rule:** Always run the Rails runner nil-clear command after every Developer Key re-import in local dev. Paste JSON import is additive, not replacing.

---

## Lesson 3: $Canvas.assignment.id Does Not Substitute in course_navigation

**Problem:** Teacher-mode code was treating `assignmentId` as present when it was not, causing incorrect behavior in the teacher config UI.

**Root Cause:** The Canvas variable `$Canvas.assignment.id` only substitutes when the LTI launch occurs in an assignment context. In `course_navigation` launches, Canvas sends the literal string `$Canvas.assignment.id` as the custom field value — it does not substitute it with a real ID.

**Fix:** Throughout the app, treat any custom field value starting with `$Canvas.` as null:
```typescript
const assignmentId = raw?.startsWith('$Canvas.') ? null : raw;
```

**Rule:** Never trust custom field values from `course_navigation` launches to be substituted. Always guard against literal `$Canvas.*` strings.

---

## Lesson 4: Deep Linking Response JWT Was Signing with Wrong Algorithm

**Problem:** Canvas was returning 400 on the Deep Linking response POST before the JWKS issue was identified.

**Root Cause:** The JWT was being signed with HS256 instead of RS256. The `LTI_PRIVATE_KEY` was either not set or not loading correctly, causing a fallback to a symmetric key.

**Fix:** 
- Generate a proper RSA 2048-bit key pair.
- Store the private key in `.env` as `LTI_PRIVATE_KEY` (full PEM string in double quotes).
- Create a shared `lti-key.util.ts` that reads `LTI_PRIVATE_KEY` and throws a clear startup error if not set.
- Verify the JWT header at jwt.io — must show `"alg": "RS256"`, not `"alg": "HS256"`.

**Rule:** Always decode the JWT at jwt.io before debugging Canvas responses. The algorithm field in the header tells you immediately if the signing is wrong.

---

## Lesson 5: ltiResourceLink vs file Content Item — The Core Architecture Decision

**Problem:** Spent most of the day going back and forth between `ltiResourceLink` and `file` content item types, with each approach having a different fatal flaw in local dev.

**The full comparison:**

| Approach | Canvas owns video? | Survives restart? | Works locally? | Teacher experience |
|---|---|---|---|---|
| `ltiResourceLink` | No — your server owns it forever | No — in-memory store wiped | Yes | Inline viewer via LTI re-launch |
| `file` content item | Yes — Canvas fetches and stores | Yes — Canvas has it | No — private IP blocked | Download link (not inline) |
| `file` + tunnel | Yes | Yes | Yes (with tunnel) | Download link |

**What we tried and why it failed:**
1. `file` content item → `InsecureUriError` on `172.22.0.1` (Lesson 1)
2. Switched to `ltiResourceLink` → works locally but server owns video forever
3. In-memory store wiped on restart → student submissions lost
4. Explored: Postgres BLOB storage → bad for large files
5. Explored: R2/S3 object storage → user didn't want external storage services
6. Explored: Canvas Files API with `as_user_id` → requires admin token we don't have in LTI 1.3
7. Explored: store video in Canvas assignment description → impossible, 50-150MB files
8. Returned to `file` content item with tunnel → Canvas fetches successfully

**Final answer:** `file` content item is correct. Canvas fetches the video within minutes and owns it permanently. The server only holds the video briefly as a handoff point. This does not work in local dev without a tunnel — that is expected and acceptable.

**Rule:** `file` content item = Canvas owns the video permanently. `ltiResourceLink` = your server owns it forever. For a scalable production app, `file` content item is the right choice.

---

## Lesson 6: Tunneling Complications (ngrok / cloudflared)

**Problem:** Setting up a tunnel to test the `file` content item path in local dev introduced multiple new issues.

**Issues encountered:**
- **Race condition:** Tunnel URL was slow to respond, causing connection errors on first load. The app appeared broken but just needed a few seconds.
- **"already_used" error:** `{"errors":{"data_jwt":[{"type":"already_used","message":"Do not attempt to submit content items multiple times."}]}}` — caused by the form auto-submitting twice due to tunnel timeout, consuming the Canvas session token on the first attempt and rejecting the second.
- **JWT verification error after tunnel:** `JWT verification failed: RS256 requires key modulusLength to be 2048 bits or larger` — the tunnel URL changed `APP_URL` but the OIDC flow still had stale state referencing the old URL.
- **URL changes on restart:** Free cloudflared tunnels give a different URL every time they restart, requiring `.env` update and server restart each session.

**Fix for double-submission:** Add a submitted flag guard in the frontend before the form auto-submits. Once submitted, prevent any further submission attempts.

**Fix for tunnel URL changes:** For stable local testing, use a paid ngrok account with a fixed subdomain, or use a free Cloudflare account with a named tunnel.

**Rule:** Tunnels are useful for verifying production-path behavior locally, but they introduce their own class of timing and state problems. Use them for targeted verification, not as a daily dev environment.

---

## Lesson 7: Canvas Jobs Background Queue Is Where File Fetch Failures Hide

**Problem:** Canvas returned HTTP 200 on the Deep Linking response POST, yet submissions were silently failing. No errors visible in the main Canvas web logs.

**Root Cause:** Canvas processes file fetches in a background job queue (`canvas-jobs-1` container), completely separate from the web container. The web container accepts the JWT and returns 200 immediately. The background job runs minutes later and is where the actual file download happens — and where failures occur.

**How to monitor:**
```bash
docker logs canvas-jobs-1 2>&1 | grep -E "(SubmitWorker|InsecureUri|deep-link-file|Completed|failed)" | tail -10
```

**Success looks like:**
```
Completed Services::SubmitHomeworkService::SubmitWorker (id=XXXXX) {...} 224ms
```

**Failure looks like:**
```
CanvasHttp::InsecureUriError
url: http://172.22.0.1:3000/api/lti/deep-link-file/...
SQL Progress Update ... "workflow_state" = 'failed'
```

**Rule:** When a Deep Linking submission appears to succeed (HTTP 200) but nothing shows up, always check `canvas-jobs-1` logs, not `canvas-web-1`.

---

## Lesson 8: In-Memory Storage Is Only Acceptable as a Temporary Handoff

**Problem:** Student video submissions were lost every time the server restarted. Teachers could not view videos submitted before the last restart.

**Root Cause:** `LtiDeepLinkFileStore` stored video buffers in Node.js memory. Any server restart wiped all stored videos.

**What we learned:**
- In-memory storage is acceptable only as a temporary buffer — the time between a student submitting and Canvas fetching the file (typically under 5 minutes).
- It is NOT acceptable as permanent storage for teacher viewing.
- The correct architecture is: in-memory as handoff → Canvas fetches → Canvas owns it permanently.
- With the `file` content item approach, once Canvas fetches the video, the in-memory store can be garbage collected. The video lives in Canvas forever.

**Rule:** Never rely on in-memory storage for anything that must survive a server restart. Use it only as a short-lived handoff mechanism.

---

## Lesson 9: Canvas Submission Attachment URLs Require Proxying for Reliable Video Playback

**Problem:** Canvas attachment URLs from the Submissions API are not reliably usable as a direct `<video src>` in the browser.

**Root Cause:** Canvas file URLs may require session cookies, may return `Content-Disposition: attachment` (triggering download instead of inline play), and may have CORS restrictions depending on Canvas configuration.

**Fix:** Proxy the video through your API:
```
GET /api/prompt/submission-video/:courseId/:assignmentId/:userId
```
- Server looks up submission via Canvas API using OAuth token
- Server fetches file from Canvas with Authorization header
- Server streams back to browser with proper headers:
  - `Content-Type: video/webm`
  - `Accept-Ranges: bytes`
  - `Content-Length`
  - `Content-Range` for range requests (required for video seeking)

**Rule:** Never use Canvas file URLs directly as video `src`. Always proxy through your API to ensure consistent playback across all environments.

---

## Lesson 10: Verify the Correct Docker Container Name Before Running Commands

**Problem:** Multiple commands failed immediately with `Error response from daemon: No such container`.

**Root Cause:** Container names in this Docker Compose setup use hyphens not underscores (`canvas-web-1` not `canvas_web`).

**Correct container names:**
```
canvas-web-1
canvas-jobs-1
canvas-webpack-1
canvas-redis-1
canvas-postgres-1
```

**Find container names any time:**
```bash
docker ps --format "table {{.Names}}\t{{.Image}}"
```

**Rule:** Always verify container names before running `docker exec` commands. Never assume the name format.

---

## Lesson 11: Bash Quoting Issues with Special Characters in Rails Runner

**Problem:** Rails runner commands with `save!` failed in bash with `event not found` error.

**Root Cause:** The `!` character has special meaning in bash history expansion.

**Fix:** Use single quotes around Ruby code passed to `rails runner`:
```bash
# WRONG - bash interprets !
docker exec -it canvas-web-1 rails runner "k.save!"

# CORRECT - single quotes prevent bash interpretation  
docker exec -it canvas-web-1 rails runner 'k.save; puts k.inspect'
```

**Rule:** Always use single quotes when passing Ruby code to `rails runner` from bash.

---

## Lesson 12: The file Content Item Produces a Download Link, Not Inline Playback

**Problem:** After getting the `file` content item working, Canvas showed the submission as a download link rather than an inline video player.

**Root Cause:** When Canvas fetches and stores a `file` content item, it treats it like any other file upload submission. SpeedGrader shows it as a file attachment, not an embedded video player. There is no way to make Canvas show an inline player for `file` content items.

**What we explored:**
- Sending both `file` and `ltiResourceLink` content items → Canvas `homework_submission` placement only reliably handles one content item; multiple items are undocumented and risky.
- `ltiResourceLink` pointing to our viewer → works for inline playback but requires server-side storage.

**Current resolution:** The teacher grading viewer in our own app fetches the video from Canvas via the proxy endpoint and plays it inline. The Canvas SpeedGrader download link is a secondary access method, not the primary teacher experience.

**Rule:** `homework_submission` with `file` content item gives teachers a download link in SpeedGrader. If you need inline playback, build your own grading viewer and point teachers to it via `course_navigation`.

---

## Lesson 13: Use `/api/debug/lti-log` to Prove Viewer/SproutVideo Flow

**Problem:** Browser Console output alone made it unclear whether the backend actually attempted SproutVideo folder lookup/listing when opening Teacher Viewer.

**Root Cause:** SproutVideo calls happen server-side in `getSubmissions`, not in the browser. Client console logs cannot prove backend execution order.

**Fix / Verification trick:**
- Hit debug ping on the same app origin to confirm log endpoint is live:
  - `http://localhost:4200/api/debug/ping`
- Open Teacher Viewer for the target assignment.
- Fetch raw log lines:
  - `http://localhost:4200/api/debug/lti-log`
- Confirm this sequence exists:
  1. `[viewer] GET submissions`
  2. `[viewer] getSubmissions`
  3. `[viewer] getSubmissions: SproutVideo folderId ...`
  4. `[viewer] getSubmissions: listVideosByFolderId called ...`
  5. `[viewer] getSubmissions: listVideosByFolderId result ...`
  6. title match result (`found` or `not found`)

**Rule:** When debugging teacher viewer video loading, treat `/api/debug/lti-log` as the source of truth for backend flow. Do not rely on browser console alone for SproutVideo request proof.

---

## Lesson 14: Canvas REST API Base URL vs LTI JWT `iss` (Instructure Cloud) — Flashcards / Teacher Settings

**Problem (symptoms):**
- Teacher flow showed the **“recreate Flashcard Settings announcement”** modal **before** the Canvas token modal, or clicking Recreate surfaced **“Canvas base URL required…”** / **“Canvas OAuth token required”** in the wrong order.
- Manually adding a Developer Key custom field (**`canvas_api_domain` = `$Canvas.api.domain`**) did not seem to fix the issue.

**Root causes:**
1. **Generic `iss` on Instructure-hosted Canvas**  
   The LTI 1.3 JWT `iss` is often **`https://canvas.instructure.com`** (platform identifier). That is **not** the per-account REST host (e.g. `https://yourschool.instructure.com`). Calling `/api/v1/...` against the generic host breaks OAuth and course APIs.

2. **Wrong resolution priority**  
   If `canvasBaseUrl` was set from that generic `iss`, code that resolved “first non-empty base URL” would **prefer it** and **never** use the real school host from custom fields or `canvasDomain`.

3. **API requests vs LTI launch for `Referer`**  
   After the tool loads in an iframe, follow-up XHR/fetch calls to the tool API often send **`Referer: <your app>`**, not the Canvas course URL — so “repair from Referer” on **every** API call is unreliable. The reliable moment is **`POST /api/lti/launch`** (and related launch endpoints), where **`Origin` / `Referer`** still point at the Canvas tenant.

**Fixes implemented (FlowStateASL):**
- **`resolveCanvasApiBaseUrl`**: Treat **`canvas.instructure.com` / beta / test** as **invalid** for REST; prefer tenant `canvasBaseUrl`, then **`canvasDomain`**, then `platformIss`, then env — skipping generic cloud hosts at each step.
- **LTI 1.3 `payloadToContext`**: Resolve tenant from, in order: custom **`$Canvas.api.baseUrl` / `$Canvas.api.domain`** (with case-insensitive custom keys), **`launch_presentation.return_url`**, deep linking return URL when present; **do not** fall back to generic `iss` as the REST base.
- **`POST /api/lti/launch` (and 1.1 launch handlers)**: If still missing/generic, **infer tenant from launch `Origin` / `Referer`** and set `session.ltiContext.canvasBaseUrl` / `canvasDomain`.
- **Teacher settings API**: Return **401** for teachers with **no** Canvas token **before** returning empty course settings, so the UI shows the **token modal first**, not the announcement recreate dialog.
- **Paste XML / custom fields**: Document and ship **`custom_canvas_api_base_url`** (`$Canvas.api.baseUrl`) and **`custom_canvas_domain`** (`$Canvas.api.domain`) in `LTI_1.1_ASL_Express_Flashcards.xml`; mirror the same names on the LTI 1.3 Developer Key **Custom Fields** where applicable.

**Rules:**
- Never treat **`https://canvas.instructure.com`** as the Canvas REST base for a specific school.
- Prefer **tenant hints** from: custom fields → **launch** `return_url` → **launch** `Origin`/`Referer` → self-hosted or non-generic `iss` → optional **`CANVAS_API_BASE_URL`** (dev/non-LTI only).
- After changing LTI or host logic, **re-launch the tool from Canvas** (or clear session) so `ltiContext` is rebuilt.

---

## Timeline of the Day

| Time | Event |
|---|---|
| Start | Deep Linking JWT returning 400 — JWKS fetch blocked by private IP |
| +1hr | Discovered `public_jwk_url` still set in DB despite Paste JSON re-import |
| +1.5hr | Cleared `public_jwk_url` via Rails runner — JWT now accepted (200) |
| +2hr | Submission "processing" spinner — video not appearing |
| +2.5hr | Found `CanvasHttp::InsecureUriError` in canvas-jobs-1 logs |
| +3hr | Switched to `ltiResourceLink` — submission works but server owns video |
| +4hr | In-memory store wiped by restart — submissions lost |
| +5hr | Long exploration of storage alternatives (Postgres, R2, Canvas Files API) |
| +6hr | Returned to `file` content item approach + cloudflared tunnel |
| +6.5hr | Tunnel race conditions and "already_used" errors |
| +7hr | File content item confirmed working — Canvas fetches and stores video |
| +7.5hr | Teacher viewer confirmed working — video plays inline |
| End | Committed stable checkpoint to GitHub |

---

## Key Commands Reference

```bash
# Find Docker container names
docker ps --format "table {{.Names}}\t{{.Image}}"

# Check if Canvas jobs are processing submissions
docker logs canvas-jobs-1 2>&1 | grep -E "(SubmitWorker|InsecureUri|deep-link-file)" | tail -10

# Check Canvas web logs for Deep Linking response
docker logs canvas-web-1 2>&1 | grep "deep_linking_response" | tail -5

# Verify Developer Key JWKS config
docker exec -it canvas-web-1 rails runner 'puts DeveloperKey.find(10000000000008).public_jwk_url.inspect'

# Clear public_jwk_url after Developer Key re-import
docker exec -it canvas-web-1 rails runner 'k = DeveloperKey.find(10000000000008); k.public_jwk_url = nil; k.save; puts k.public_jwk_url.inspect'

# Start cloudflared tunnel
cloudflared tunnel --url http://localhost:3000
```

---

*FlowStateASL — ASL Express Prompt Manager — LTI 1.3 Deep Linking Lessons Learned*

---

## Homework Submission / Module Placement Follow-up — April 4, 2026

## Lesson 15: API-Created ExternalTool Module Items Can Succeed Structurally While Failing Launch Association

**Problem:** Module item creation returned success, but launch still failed with "valid setting for this link" behavior.

**Root Cause:** A successful Modules API create does not guarantee a valid LTI launch association. In repeated runs, the created module items had:
- `diagnosisBucket = tool_launch_mismatch`
- `resourceLinksCount = 0`
- no `resourceLinkId`/`ltiResourceLinkId` signals

**What this means:** "Created" is not equivalent to "launchable." Post-create probes must verify launch association, not just HTTP 2xx on create.

**Rule:** Treat module-link creation as two gates:
1) item created
2) launch association present
If gate (2) fails, do not treat the flow as working.

---

## Lesson 16: Assignment-Anchor Is the Primary Unified Path Across LTI 1.1 and 1.3

**Problem:** Earlier strategy treated 1.1 and 1.3 as separate primary workstreams.

**Resolution:** Live validation confirmed assignment-anchor works as the primary path in both versions. The architecture is now:
- one primary path: `assignment_anchor`
- version-aware fallback chain only when anchor fails

**Rule:** Maintain one primary placement strategy, not parallel primary tracks by version.

---

## Lesson 17: 1.3 Validation Must Be Scored by Correct Fallback Behavior, Not Full Placement Success

**Problem:** Expecting full 1.3 placement resolution during a phase where `deep_link_13` is intentionally stubbed causes false failure conclusions.

**Resolution:** 1.3 runs were validated by marker sequence and graceful termination behavior:
- `ltiVersionDetected` (`1.3`)
- `assignmentAnchorLaunchFail` (when forced)
- `templateCloneBlockedFor13`
- `deepLink13NotImplemented`
- terminal `manual_hybrid` marker with reason/code

**Rule:** During stub phases, success criteria are correct branch routing + terminal diagnostics, not complete functional parity.

---

## Lesson 18: Structured Placement Markers with Attempt IDs Turn Debugging Into Deterministic Evidence

**Problem:** Free-form logs made multi-branch placement failures hard to reconstruct and compare.

**Resolution:** Standardized placement marker payload enabled deterministic tracing:
`{ placementAttemptId, ltiVersion, path, marker, outcome, reason?, canvasResponseCode? }`

Critical effect:
- every branch and failure exit produced explicit terminal evidence
- one `placementAttemptId` ties the entire decision chain together

**Rule:** For decision-tree flows, require branch-complete structured markers with a per-attempt ID and terminal outcome marker.

---

## Lesson 19: Real 1.3 Signed Launch Automation Is Possible Without Guessing OIDC Parameters

**Problem:** Directly guessing `lti_message_hint` or OIDC params produced invalid request errors.

**Resolution:** Reliable automation path:
1. Get a real Canvas sessionless launch URL for a module item
2. Read Canvas-rendered OIDC hidden inputs (`iss`, `login_hint`, `client_id`, `target_link_uri`, `lti_message_hint`)
3. Replay OIDC login + auth chain
4. Post real signed `id_token` + `state` to `/api/lti/launch`

This produced a true 1.3 session for downstream save-flow validation.

**Rule:** Never synthesize `lti_message_hint`; harvest real values from Canvas launch HTML.

---

## Lesson 20: Environment/Session Context Mismatch Is a First-Class Failure Mode

**Problem:** Validation scripts can report misleading failures if API server/session state is stale or mis-hydrated (missing launch-type context, missing session continuity, malformed body mode).

**Resolution:** Reliable run discipline:
- verify API availability first
- ensure launch context is created in the same cookie/session used for save calls
- use request body mode expected by endpoint
- confirm branch evidence from placement markers, not just response code

**Rule:** In LTI validation, session continuity and context hydration are part of the test contract.

---

## Lesson X — Code to Outcomes, Not Methods

**Problem:** Investigation anchored to a specific API method (Modules API payload variants) and kept optimizing it after consistent negative evidence, consuming hours without questioning whether the approach itself was wrong.

**Resolution:** Reframing from "make the Modules API work" to "auto-place a functional LTI module item that launches correctly" immediately opened the assignment-anchor path that solved the problem across both LTI versions.

**Rule:** When approaching any implementation problem, define the desired outcome first and treat any specific method as one candidate path, not the destination. When a method produces consistent negative evidence, question the method before optimizing it further.

---

## Lesson Y — Apply Diagnostics That Match the LTI Version of the Environment

**Problem:** Eight hours were spent probing LTI 1.3 constructs (Lti::ResourceLink records, sessionless launch associations, resource link probes) in a production environment running LTI 1.1. These probes returned empty not because anything was broken, but because those constructs do not exist in LTI 1.1. The diagnostic was measuring the wrong thing, producing misleading failure evidence and a premature go-no-go conclusion.

**Resolution:** Establishing the runtime LTI version as a prerequisite to any diagnostic work — and using only the diagnostic constructs appropriate to that version — eliminated the false signals entirely.

**Rule:** Before running any LTI diagnostic, confirm the runtime version. Never apply 1.3 diagnostic constructs (resource link probes, Deep Linking association checks) to a 1.1 environment. Treat version mismatch between diagnostics and environment as a first-class failure mode.

---

## Lesson Z — Automation-First Verification Is the Default When Stuck

**Problem:** Manual click/retest loops are slow, inconsistent, and tend to blur signal with noise when debugging complex launch flows. They also delay hard go/no-go decisions by relying on subjective observations.

**Resolution:** Converting blocked investigations into scripted, repeatable validation runs (API experiments, session bootstrap, save-flow execution, marker capture) produced deterministic evidence quickly, exposed branch behavior clearly, and prevented further time loss on guesswork.

**Rule:** When progress stalls, switch immediately to automation-first verification. Treat scripted repro + structured evidence capture as the default method for breaking deadlocks, not a last resort.
