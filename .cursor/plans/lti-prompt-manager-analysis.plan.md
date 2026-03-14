# LTI 1.3 Project Analysis & Prompt Manager Integration Plan

**Scope:** Analysis only. No code changes. This document covers project structure, existing LTI 1.3 integration (Flashcards), Prompt Manager (PHP and Nest/React) analysis, gap analysis, and a step-by-step migration plan to integrate Prompt Manager with LTI 1.3.

---

## 1. Project Structure

### 1.1 Top-level layout

| Path | Purpose |
|------|--------|
| `apps/api` | NestJS API: LTI launch, JWKS, OIDC, flashcard/submission/course-settings, session, SPA fallback |
| `apps/web` | React SPA (Vite): Flashcards and Prompter UIs; consumes `/api/lti/context` and API routes |
| `libs/shared-types` | Shared TypeScript types (e.g. `LtiContext`) |
| `ASLexpressFlashcards` | Legacy PHP LTI 1.1 Flashcards (separate deploy; reference configs) |
| `ASLexpressPromptManager` | **Prompt Manager**: PHP LTI 1.1 timed practice tool (launch → `timer.php`) |

### 1.2 LTI integration status

| Component | LTI 1.3 integrated? | Notes |
|-----------|---------------------|--------|
| **Flashcards** (Nest + React) | **Yes** | `POST /api/lti/launch/flashcards` (1.1) and `POST /api/lti/launch` (1.3) → session → redirect `/flashcards` |
| **Prompt Manager** (Nest + React "Prompter") | **Partially** | LTI 1.1: `POST /api/lti/launch/prompter` exists; LTI 1.3 uses same `POST /api/lti/launch` and `ctx.toolType` from JWT `custom.tool_type` |
| **Prompt Manager** (PHP) | **LTI 1.1 only** | `lti_timed_launch.php` receives POST from Canvas 1.1; no OIDC/JWT flow |

### 1.3 Tools and subdirectories

- **Flashcards (integrated):**  
  - Backend: `apps/api` (LtiController, FlashcardController, SubmissionController, LtiLaunchGuard, session).  
  - Frontend: `apps/web` → `FlashcardsPage`, `/flashcards` route.  
  - Launch: LTI 1.1 → `POST /api/lti/launch/flashcards`; LTI 1.3 → OIDC then `POST /api/lti/launch` with JWT; `toolType` set to `flashcards` or from `custom.tool_type`.

- **Prompt Manager (PHP, not LTI 1.3):**  
  - `ASLexpressPromptManager/`: `lti_timed_launch.php` (LTI 1.1 entry), `timer.php` (root), `dev2/timer.php`, `dev2/viewer.php`, `dev2/save_prompt.php`, `dev2/save_session.php`, canvas/sprout/ai bridges, SQLite (prompt_configs, blocked_attempts, etc.).  
  - Auth/session: PHP session; LTI params from `$_POST`/`$_GET`; no JWT, no OIDC.

- **Prompt Manager (Nest/React "Prompter"):**  
  - Backend: same `apps/api` (LtiController `launch/prompter` and LTI 1.3 `launch` with `toolType === 'prompter'`, AssessmentService for sync, course-settings, submission).  
  - Frontend: `apps/web` → `TimerPage` at `/prompter`; currently a placeholder.  
  - Launch: LTI 1.1 → `POST /api/lti/launch/prompter`; LTI 1.3 → same `POST /api/lti/launch` with `custom.tool_type === 'prompter'`.

---

## 2. Existing LTI 1.3 Integration (Flashcards) – End-to-End

### 2.1 Config and URLs

- **Developer Key (Canvas):** `LTI_1.3_Developer_Key_Canvas.json`
  - `oidc_initiation_url`: `https://flowstateasl.onrender.com/api/lti/oidc/login`
  - `target_link_uri`: `https://flowstateasl.onrender.com/api/lti/launch`
  - `redirect_uris`: `["https://flowstateasl.onrender.com/api/lti/launch"]`
  - `public_jwk_url`: `https://flowstateasl.onrender.com/api/lti/jwks`
  - **Single launch URL** for both tools; tool type comes from JWT custom claim `tool_type` (see below).

- **Custom fields (root and placements):**
  - `course_id` = `$Canvas.course.id`
  - `assignment_id` = `$Canvas.assignment.id`
  - `user_id` = `$Canvas.user.id`
  - `module_id` = `$Canvas.module.id`
  - `roles` = `$Canvas.membership.roles`
  - **Note:** `tool_type` is **not** in the current JSON. For LTI 1.3, `toolType` is derived in code as `custom.tool_type === 'prompter' ? 'prompter' : 'flashcards'` (default flashcards).

### 2.2 Flow (LTI 1.3)

1. **Canvas** redirects user to `GET/POST /api/lti/oidc/login` with `iss`, `login_hint`, `target_link_uri`, `client_id`, (optional) `lti_message_hint`.
2. **LtiController.handleOidcLogin** validates params, generates `state`/`nonce`, stores them (and `redirect_uri`, `target_link_uri`) in `lti-oidc-state.store`, redirects browser to Canvas auth URL (`/api/lti/authorize_redirect` on `iss`) with `redirect_uri` = our `LTI_REDIRECT_URI` (e.g. `https://.../api/lti/launch`).
3. **Canvas** POSTs to `POST /api/lti/launch` with `id_token`, `state` (form_post).
4. **LtiController.launch13**:
   - Consumes `state` via `consumeOidcState(state)`.
   - Validates JWT with **Lti13LaunchService**: fetches Canvas JWKS from `iss`'s `/api/lti/security/jwks`, verifies signature/iss/aud/exp.
   - **Lti13LaunchService.payloadToContext** builds `LtiContext` from JWT:
     - `courseId` from `custom.course_id` (preferred) or `context.id`
     - `userId` from `sub`
     - `resourceLinkId` from `resource_link.id`, `resourceLinkTitle` from `resource_link.title`
     - `assignmentId` / `moduleId` / `roles` from custom claims
     - **`toolType`** = `custom.tool_type === 'prompter' ? 'prompter' : 'flashcards'`
     - `canvasBaseUrl` / `canvasDomain` from `iss` URL
   - Optionally runs teacher assignment sync for prompter.
   - Creates one-time `lti_token`, stores context in `lti-token.store` and in `req.session.ltiContext`, redirects to `FRONTEND_URL + (ctx.toolType === 'prompter' ? '/prompter' : '/flashcards')?lti_token=<token>`.
5. **Browser** loads SPA (e.g. `/flashcards`). **useLtiContext** calls `GET /api/lti/context?lti_token=...` with credentials; API returns context from token (and consumes token), then stores context in session; subsequent calls use session.
6. **AppRouter** uses `context.toolType` to show either Flashcards or Prompter routes; **LtiLaunchGuard** on protected API routes ensures `req.session.ltiContext` exists.

### 2.3 Key files

- **Routes / handlers:** `apps/api/src/lti/lti.controller.ts`  
  - `POST launch/flashcards`, `POST launch/prompter` (LTI 1.1)  
  - `GET jwks`, `GET/POST oidc/login`, `POST launch` (LTI 1.3)  
  - `GET context`
- **JWT validation / context from JWT:** `apps/api/src/lti/lti13-launch.service.ts`  
  - `validateAndExtract(idToken)`, `payloadToContext(payload)`  
  - Uses standard LTI 1.3 claim URIs for roles, resource_link, context, custom.
- **JWKS:** `apps/api/src/lti/lti-jwks.service.ts` (public key for Canvas; not used for verifying Canvas's JWT – we use Canvas's JWKS).
- **State:** `apps/api/src/lti/lti-oidc-state.store.ts` (state/nonce/redirect_uri/target_link_uri).  
- **Token bridge:** `apps/api/src/lti/lti-token.store.ts` (one-time token → LtiContext for first SPA load).  
- **Session:** `apps/api/src/main.ts` (express-session with connect-pg-simple); `lti.service.ts` extends SessionData with `ltiContext`, `canvasAccessToken`.  
- **Guard:** `apps/api/src/lti/guards/lti-launch.guard.ts` – requires `req.session.ltiContext`.  
- **Interfaces:** `apps/api/src/common/interfaces/lti-context.interface.ts`, `libs/shared-types/src/lti-context.interface.ts` (courseId, assignmentId, userId, resourceLinkId, moduleId, toolType, roles, resourceLinkTitle, lisOutcomeServiceUrl, lisResultSourcedid, canvasDomain, canvasBaseUrl, etc.).  
- **SPA:** `apps/web/src/AppRouter.tsx` (routes by `toolType`), `apps/web/src/hooks/useLtiContext.ts` (fetch `/api/lti/context`, optional `lti_token`).  
- **Scoping to subdirectory:** The app is a single SPA; "subdirectory" is the React path (`/flashcards` vs `/prompter`). No separate backend path per tool; both use same API and same session. SPA is served by `apps/api` (production: static from `web`; dev often separate Vite server) for non-`/api` GET requests.

### 2.4 LTI 1.1 vs 1.3 for Flashcards

- **1.1:** Canvas POSTs form to `POST /api/lti/launch/flashcards`. `LtiService.extractContext(body)` + `ctx.toolType = 'flashcards'` → session + redirect `/flashcards?lti_token=...`.
- **1.3:** Canvas → OIDC login → `POST /api/lti/launch` with JWT → same session + token + redirect to `/flashcards` or `/prompter` based on `custom.tool_type`.

---

## 3. Prompt Manager – Deeper Analysis

### 3.1 PHP Prompt Manager (`ASLexpressPromptManager`)

- **Entry:** `lti_timed_launch.php`  
  - Expects LTI 1.1 POST (or GET for tests): `custom_canvas_course_id` / `custom_course_id`, `resource_link_id` (or custom variants), `custom_module_id`, `custom_canvas_assignment_id`, `custom_roles`, `custom_canvas_user_id`.  
  - Validates `course_id`; builds `$course_id`, `$assignment_id`, `$canvas_user_id`, `$resourceLinkId`, `$moduleId`, `$roles`; detects teacher via `isTeacherRole($roles)`.  
  - Teachers: can be redirected to `viewer.php` for grading when `assignment_id` present; else version selector + include of version-specific `timer.php`.  
  - Loads/saves config from SQLite `prompt_configs(course_id, resource_link_id)`.  
  - Includes `timer.php` (root or subdir, e.g. `dev2/timer.php`) so the same LTI context is available in the timer UI.

- **Routes / "routes":**  
  - No router; entry is `lti_timed_launch.php`.  
  - Other endpoints: `timer.php` (UI + forms), `viewer.php`, `save_prompt.php`, `save_session.php`, `submit_prompt_first.php`, `upload_handler.php`, `canvas_bridge.php`, `sprout_bridge.php`, `ai_proxy.php`, `hf_proxy.php` – all used via direct PHP includes or form POST/GET from the timer UI.

- **Auth / session:**  
  - PHP `session_start()` in launch and in each script that needs session.  
  - LTI identity and context only from POST/GET (and re-posted hidden fields). No JWT; no OIDC.  
  - Access control: teacher vs student via `custom_roles`; student access code and blocked-attempts in SQLite; optional Canvas API token in env for submission checks.

- **What it would need from an LTI 1.3 launch:**  
  - Same logical context: `course_id`, `assignment_id`, `user_id`, `resource_link_id`, `module_id`, `roles`, and optionally `resource_link_title`, `lis_outcome_service_url`, `lis_result_sourcedid`, Canvas base URL.  
  - In LTI 1.3 these come from the JWT (and our backend already maps them into `LtiContext`). So the PHP app would need either: (a) to be replaced by the Nest/React Prompter and receive this via existing `/api/lti/context`, or (b) to receive the same data by some bridge (e.g. API that accepts an LTI 1.3 launch and then redirects to PHP with signed or session-bound params), which is more complex and not recommended.

### 3.2 Nest/React "Prompter" (current)

- **Routes:**  
  - `/prompter` → `TimerPage` (placeholder).  
  - `/config` → `TeacherConfigPage`.  
  - AppRouter shows these when `context.toolType === 'prompter'`.

- **Auth / context:**  
  - Same as Flashcards: must be launched via LTI; `useLtiContext()` → `GET /api/lti/context` (with optional `lti_token`) → session holds `ltiContext`.  
  - All protected API routes use `LtiLaunchGuard` and read `req.session.ltiContext`.

- **Backend APIs used by Prompter (or planned):**  
  - Assessment: `AssessmentService.syncAssignmentNameIfNeeded` on teacher launch (called from LtiController).  
  - Course settings: `CourseSettingsController` (GET/PUT) – LtiLaunchGuard, uses session `ltiContext` and optional `canvasAccessToken`.  
  - Submission: `SubmissionController` – LtiLaunchGuard; currently `submitFlashcard`; prompter would need submission with video/recording (per NESTJS_MIGRATION_PLAN).  
  - No dedicated assessment controller in codebase; assessment config/access/attempt and prompt/session may be in other modules or not yet exposed.

- **What the Prompter needs from LTI 1.3:**  
  - Same `LtiContext` as Flashcards: courseId, assignmentId, userId, resourceLinkId, moduleId, roles, resourceLinkTitle, lisOutcomeServiceUrl, lisResultSourcedid, canvasBaseUrl.  
  - This is already produced by `Lti13LaunchService.payloadToContext` when `custom.tool_type === 'prompter'`.  
  - So the missing piece for "Prompt Manager integrated with LTI 1.3" is: (1) ensuring Canvas sends launches with `tool_type=prompter` for Prompter links, and (2) completing the React Prompter UI and any missing assessment/submission APIs so that the existing LTI 1.3 launch path for prompter is fully usable.

---

## 4. Gap Analysis: Flashcards (LTI 1.3) vs Prompt Manager

### 4.1 What Flashcards has (and Prompt Manager lacks for "same" experience)

| Area | Flashcards (LTI 1.3) | Prompt Manager (PHP) | Prompt Manager (Nest/React) |
|------|----------------------|-----------------------|-----------------------------|
| Launch URL | OIDC → `POST /api/lti/launch` | N/A (1.1 only) | Same backend; needs `tool_type=prompter` in JWT |
| Custom fields | course_id, assignment_id, user_id, module_id, roles (in Developer Key) | Same in LTI 1.1 XML | Same via JWT custom; **tool_type not in key** |
| Tool type | Set by path (1.1) or JWT custom (1.3) | N/A (single tool) | Set by JWT `custom.tool_type`; default flashcards if missing |
| Session | express-session + lti_token bridge | PHP session | Same as Flashcards |
| Context API | `GET /api/lti/context` | N/A | Same |
| Guard on APIs | LtiLaunchGuard on flashcard, submission, course-settings | N/A | Same guard; Prompter uses same session |
| SPA route | `/flashcards` | N/A | `/prompter` (placeholder) |
| Full UI | FlashcardsPage | PHP timer.php | TimerPage placeholder |

### 4.2 What Prompt Manager has that Flashcards doesn't need

- PHP: SQLite (prompt_configs, blocked_attempts, student_resets, assignment_prompts); access code flow; version selector; viewer for grading; Canvas submission check via env token.  
- Nest/React: AssessmentService (sync assignment name); course-settings; submission service (flashcard progress today; video submission planned); no full timer/recorder UI yet.

### 4.3 Changes needed for Prompt Manager to reach parity with Flashcards LTI integration

1. **LMS (Canvas) configuration**  
   - For LTI 1.3, ensure a Prompter link sends `tool_type=prompter` in the launch JWT.  
   - Options: add a **second placement** (e.g. "ASL Express Prompter") with a custom field `tool_type` = literal `prompter` if the platform supports it; or use **Deep Linking** so that when the teacher adds a "Prompter" link, the content item includes custom param `tool_type=prompter`; or **two Developer Keys** (one per tool) and map key/client_id to default tool type in the app.  
   - Current single placement and single target_link_uri default to `flashcards` because `custom.tool_type` is absent.

2. **Backend (already in place for 1.3 prompter)**  
   - `POST /api/lti/launch` already sets `ctx.toolType` from JWT and redirects to `/prompter` when `toolType === 'prompter'`.  
   - No change required for "receiving" LTI 1.3 Prompter launches once Canvas sends `tool_type=prompter`.

3. **Frontend**  
   - `AppRouter` and `useLtiContext` already route to `/prompter` when `context.toolType === 'prompter'`.  
   - **Gap:** `TimerPage` is a placeholder; PHP `timer.php` has the real flow (warmup, prompts, recording, access code, submission). Either build out TimerPage (and related APIs) in React, or keep PHP and add a bridge (not recommended).

4. **PHP Prompt Manager**  
   - To use LTI 1.3 **without** moving to Nest/React: would need an intermediary that performs OIDC + JWT validation, then redirects to PHP with a secure token or session handoff and the same context. This duplicates logic and is fragile; **recommended** is to treat the Nest/React Prompter as the LTI 1.3 path and migrate functionality from PHP into it.

---

## 5. Migration Plan: Prompt Manager LTI 1.3 Integration

Goal: From LMS configuration to a working, testable LTI 1.3 launch into the Prompter (Nest/React) experience.

### Step 1: LMS custom field / placement for Prompter (Canvas)

- **1.1** Decide how Canvas will send `tool_type=prompter`:  
  - **Option A:** Add a second placement in the same Developer Key (e.g. "ASL Express Prompter") with the same `target_link_uri` and add a custom field with a **literal** value `tool_type=prompter` (if Canvas supports literal custom params per placement).  
  - **Option B:** Use Link Selection (Deep Linking): when the tool returns a "Prompter" content item, include custom parameter `tool_type=prompter`; on subsequent Resource Link launches, Canvas will send that in the JWT.  
  - **Option C:** Create a second LTI 1.3 Developer Key for "ASL Express Prompter" with the same OIDC/launch URLs; in the app, map that key's `client_id` (from JWT `aud`) to default `toolType = 'prompter'` when `custom.tool_type` is missing.  
- **1.2** Update the Developer Key JSON (and/or create a second key) and document which placement or key is used for Prompter.  
- **1.3** Install or update the app in Canvas (by Client ID). Create a course/module link that uses the Prompter placement or key.  
- **Risk/ambiguity:** Canvas's support for literal custom field values (not substitution) in a placement may vary; Deep Linking or a second key are fallbacks.

### Step 2: Backend – ensure Prompter path is used for 1.3

- **2.1** Confirm `Lti13LaunchService.payloadToContext` sets `toolType = 'prompter'` when `custom.tool_type === 'prompter'`. (Already implemented.)  
- **2.2** If using Option C (second key): in `Lti13LaunchService` or LtiController, when `custom.tool_type` is missing, optionally set `toolType` from a config map keyed by JWT `aud` (client_id).  
- **2.3** Ensure teacher prompter launch still runs `AssessmentService.syncAssignmentNameIfNeeded` (already in `launch13`).  
- **2.4** No change to `POST /api/lti/launch` URL or redirect_uris; same endpoint for both tools.

### Step 3: Frontend – Prompter entry and context

- **3.1** Confirm `useLtiContext` and `AppRouter` show Prompter routes when `context.toolType === 'prompter'`. (Already the case.)  
- **3.2** Ensure production SPA is built and served so that `/prompter` and `/config` load the same app and get context via `GET /api/lti/context` (with cookie or lti_token).  
- **3.3** (Optional) Add a minimal "Prompter launched" message or debug line on TimerPage so that an LTI 1.3 Prompter launch is visibly distinct from flashcards.

### Step 4: Test LTI 1.3 Prompter launch

- **4.1** In Canvas, open the Prompter link (or the link created with the Prompter placement/key).  
- **4.2** Expect: OIDC redirect to your API, then redirect to `POST /api/lti/launch`, then redirect to `FRONTEND_URL/prompter?lti_token=...`.  
- **4.3** SPA loads, calls `GET /api/lti/context?lti_token=...`, gets context with `toolType: 'prompter'`, and shows Prompter UI (TimerPage).  
- **4.4** Verify: no redirect to `/flashcards`, and Bridge Log (or equivalent) shows prompter context.  
- **Risks:** If `tool_type` is never sent, you'll get flashcards by default; fix by completing Step 1. Session cookie and CORS must allow same-origin or configured origin with credentials.

### Step 5: (Later) Full Prompter feature parity with PHP

- **5.1** Implement or expose assessment config/access/attempt and prompt/session APIs as in NESTJS_MIGRATION_PLAN (Phase D–F).  
- **5.2** Build TimerPage: warmup timer, prompts, access code, recording, submission (video + grade) using existing or new submission/assessment endpoints.  
- **5.3** Migrate teacher config and student flows from PHP to React + API; then retire or redirect PHP Prompt Manager for LTI 1.3.

### Risks and ambiguities

- **Tool type in LTI 1.3:** Current Developer Key does not include `tool_type`. Default is flashcards. Need an explicit way (placement, Deep Link, or second key) for Prompter launches to send `tool_type=prompter`.  
- **Deep Linking:** LTI_DEBUG_FINDINGS.md notes that link_selection currently does not implement the Deep Linking response; course_navigation works. For "add Prompter link from module," Deep Linking may be required.  
- **Two tools, one URL:** Single `target_link_uri` and single `POST /api/lti/launch` are correct; differentiation is by JWT custom only (or by client_id if using two keys).  
- **PHP vs Nest/React:** Full parity means building Prompter UI and APIs in Nest/React; the "integration" plan above gets the LTI 1.3 launch and context correct; feature parity is a separate product/development effort.

---

## 6. Summary

- **Project structure:** Monorepo with `apps/api` (NestJS), `apps/web` (React), legacy PHP in `ASLexpressPromptManager` and `ASLexpressFlashcards`.  
- **LTI 1.3 (Flashcards):** OIDC login → `POST /api/lti/launch` → JWT validated → `LtiContext` (including `toolType` from `custom.tool_type`) → session + one-time token → redirect to SPA `/flashcards` or `/prompter` → `GET /api/lti/context` → AppRouter and LtiLaunchGuard.  
- **Prompt Manager (PHP):** LTI 1.1 only; `lti_timed_launch.php` → timer.php; session and POST/GET; would need same context from LTI 1.3, best delivered by using the Nest/React Prompter path.  
- **Prompt Manager (Nest/React):** Launch and context path exist; missing: Canvas sending `tool_type=prompter`, and full TimerPage/APIs.  
- **Migration:** Configure Canvas so Prompter sends `tool_type=prompter` (placement / Deep Link / second key); keep current backend; verify redirect and context; then iterate on Prompter UI and APIs.
