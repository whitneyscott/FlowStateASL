# LTI Shared Helpers — Implementation Plan

Derived from [LTI_1.3_FLOW_ANALYSIS_AND_SHARED_HELPERS.md](LTI_1.3_FLOW_ANALYSIS_AND_SHARED_HELPERS.md). Each step is scoped for implementation and test in isolation. **The project uses LTI 1.3 exclusively**; LTI 1.1 endpoints are deprecated and are not refactored or wired to new helpers. Existing Flashcards functionality (via LTI 1.3 launch) must not be broken — shared helpers are extracted and verified with Flashcards before any Prompt Manager use.

---

## Phase A: LTI launch helpers (extract only; Flashcards behavior unchanged)

### Step 1 — Extract LTI error HTML to a shared util **(Done)**

- **Scope:** Create `apps/api/src/lti/lti-error.util.ts` with `renderLtiLaunchErrorHtml(message: string, options?: { frontendUrl?: string; debugPath?: string })`. Debug link = `${frontendUrl ?? ''}${debugPath ?? '?debug=1'}` so it is not hardcoded to `/flashcards`. Update `apps/api/src/lti/lti.controller.ts`: remove the inline `ltiErrorHtml` function and import/call `renderLtiLaunchErrorHtml` from the util (pass `frontendUrl` from config and e.g. `debugPath: '?debug=1'` or omit for generic link).
- **Test checkpoint:** Run API; trigger an LTI 1.3 launch error (e.g. invalid state or missing id_token). Confirm the error page renders and the debug link points to the frontend (e.g. `FRONTEND_URL?debug=1` or as configured). Confirm LTI 1.3 launch still succeeds when params are valid.

### Step 2 — Extract redirect path by tool type (LTI 1.3 only) **(Done)**

- **Scope:** Create `apps/api/src/lti/lti-redirect.util.ts` with a constant map `TOOL_TYPE_SPA_PATHS: Record<'flashcards' | 'prompter', string>` (e.g. `{ flashcards: '/flashcards', prompter: '/prompter' }`) and a function `getRedirectPathForToolType(toolType: 'flashcards' | 'prompter'): string` that returns the path. Update `apps/api/src/lti/lti.controller.ts` **only in `launch13`** (LTI 1.3): replace the inline `path = ctx.toolType === 'prompter' ? '/prompter' : '/flashcards'` with `getRedirectPathForToolType(ctx.toolType)`. Do **not** refactor the deprecated LTI 1.1 handlers (`launchFlashcards`, `launchPrompter`); they keep literal paths (`/flashcards`, `/prompter`) and are not wired to this helper.
- **Test checkpoint:** Launch from Canvas via the LTI 1.3 tool (e.g. open the course external tool URL such as `/courses/1/external_tools/35`). After the app loads, open the **Bridge Debug Log** (e.g. add `?debug=1` to the app URL). Confirm the log shows **Redirect path (Step 2): /flashcards** for the flashcards tool (or **Redirect path (Step 2): /prompter** for the prompter tool). The browser address bar should show `FRONTEND_URL/flashcards?lti_token=...` (or `/prompter?lti_token=...`). (LTI 1.1 endpoints are deprecated and unchanged.)

### Step 3a — Extract persist context + redirect helper; wire into launch13 only **(Done)**

- **Scope:** Create `apps/api/src/lti/lti-launch-finish.util.ts` with a function `persistLtiContextAndRedirect(req: Request, res: Response, ctx: LtiContext, buildRedirectUrl: (token: string) => string, options?: { oauthInitUrl?: string })`: generate one-time token, call `setLtiToken(token, ctx)`, set `req.session.ltiContext = ctx`, call `req.session.save(callback)`; in the callback, if `options?.oauthInitUrl` is set, redirect to it, else redirect to `buildRedirectUrl(token)`. Update `apps/api/src/lti/lti.controller.ts` only in `launch13`: after computing base and path (using `getRedirectPathForToolType(ctx.toolType)`), replace the token/session/save/redirect block with a call to `persistLtiContextAndRedirect(req, res, ctx, (token) => \`${base}${path}?lti_token=${token}\`, { oauthInitUrl })`. Do not change `launchFlashcards` or `launchPrompter` in this step.
- **Test checkpoint:** LTI 1.3 launch end-to-end: OIDC login → POST launch with id_token/state → session contains `ltiContext`, redirect to `FRONTEND_URL/flashcards?lti_token=...` or `.../prompter?lti_token=...` as appropriate. SPA loads and `GET /api/lti/context` returns context. OAuth redirect path (when configured and user has no token) still redirects to `/api/oauth/canvas?returnTo=...`. (Do not change deprecated LTI 1.1 handlers.)

### Step 4 — LTI 1.3 tool type mapping and default **(Done)**

- **Scope:** In `apps/api/src/lti/lti13-launch.service.ts`, in `payloadToContext`, ensure default `toolType` is `'flashcards'` and introduce a constant map for `custom.tool_type` → toolType (e.g. `prompter` → `'prompter'`, default `'flashcards'`). No change to deprecated LTI 1.1 code paths.
- **Test checkpoint:** LTI 1.3 launch with `custom.tool_type === 'prompter'` yields `toolType: 'prompter'`; otherwise `toolType: 'flashcards'`. No change in observed behavior.

### Step 5 — Verify Prompter LTI 1.3 launch before building submission **(Done)**

- **Scope:** No code change. Checkpoint only. Ensure Canvas is configured so that a Prompter link sends `tool_type=prompter` in the LTI 1.3 launch (e.g. second placement, Deep Link, or second Developer Key). Launch the Prompter from Canvas via LTI 1.3 (OIDC → POST launch).
- **Test checkpoint:** LTI 1.3 launch with tool_type=prompter completes successfully: session contains `ltiContext` with `toolType: 'prompter'`, redirect goes to `FRONTEND_URL/prompter?lti_token=...`, SPA loads and routes to `/prompter`, and `GET /api/lti/context` returns context with toolType prompter. Confirms the launch path is correct before any submission or Phase B work.

### Step 6 — Capture AGS lineitem URLs in LtiContext at launch **(Done)**

- **Scope:** The LTI 1.3 launch JWT from Canvas includes AGS claim URLs (lineitem and/or lineitems). These must be available in session for Step 11b (lineitem resolution). In `apps/api/src/lti/lti13-launch.service.ts`, in `payloadToContext`, read the AGS claims from the JWT (e.g. `https://purl.imsglobal.org/spec/lti-ags/claim/lineitems`, and optionally the single lineitem URL when present). Extend `LtiContext` in `apps/api/src/common/interfaces/lti-context.interface.ts` (and `libs/shared-types/src/lti-context.interface.ts` if used by web) with optional fields, e.g. `agsLineitemsUrl?: string` and `agsLineitemUrl?: string`. Store these in the context returned by `payloadToContext` so they are persisted in session. No change to Canvas or submission code yet.
- **Test checkpoint:** After LTI 1.3 launch from Canvas (with AGS enabled in the Developer Key), `req.session.ltiContext` (and `GET /api/lti/context` response) includes `agsLineitemsUrl` and/or `agsLineitemUrl` when Canvas sends them. Step 11b will use these values for lineitem resolution.

---

## Token usage (Steps 7–10 vs Steps 11a–11d)

**Steps 7–10** (find-or-create assignment, write submission body, Flashcards submission) use the **Canvas OAuth REST token**: the token obtained via the Canvas OAuth flow and stored in session (`canvasAccessToken`), or resolved via CourseSettingsService. This token is used for Canvas REST API calls (assignments, submissions).

**Steps 11a–11d** (LtiAgsService) use a **separate LTI 1.3 AGS token**: obtained from the platform token endpoint using a signed JWT assertion (client_credentials-style request with the tool's private key). Used only for AGS (lineitems, score, result).

These two tokens are **not interchangeable**. Do not use the OAuth token for AGS; do not use the AGS token for Canvas REST.

**Note for implementers:** A 403 "user not authorized" when students submit (e.g. via Canvas REST `createSubmissionWithBody` using the student's OAuth token, especially for Test User / Student View) is **not a bug to patch around**. It confirms that the REST/OAuth submission approach has hit its ceiling—Canvas limits student-scoped API calls and Test User flows. AGS uses client credentials (JWT assertion), not per-user OAuth, and can submit on behalf of any user. Prioritize Phase D (Steps 11a–11d, Step 12) to implement AGS rather than attempting workarounds for the 403.

---

## Phase B: Shared find-or-create assignment (Flashcards uses it first)

### Step 7 — Add shared ensureAssignmentForCourse **(Done)**

- **Scope:** Add to `apps/api/src/canvas/canvas.service.ts` a new method `ensureAssignmentForCourse(ctx: LtiContext, config: { title: string; description?: string; submissionTypes?: string[]; pointsPossible?: number; published?: boolean; omitFromFinalGrade?: boolean }, tokenOverride?: string | null): Promise<string>`. Implementation: resolve base URL from `ctx.canvasBaseUrl ?? ctx.canvasDomain`; **token is the Canvas OAuth token** — callers (e.g. CourseSettingsService) pass it via `tokenOverride` from session/CourseSettingsService.getEffectiveCanvasToken; call existing `findAssignmentByTitle(courseId, config.title, ...)`; if not found, call existing `ensureAssignmentGroup` for a group named like the title (or a generic one), then `createAssignment` with config; return assignment ID. Do not change `ensureFlashcardProgressAssignment` or `getProgressAssignmentId` yet. Alternatively, put `ensureAssignmentForCourse` in a small service that depends on CanvasService and CourseSettingsService and accepts ctx + config.
- **Test checkpoint:** Unit test or manual test: call `ensureAssignmentForCourse` with Flashcard Progress title and config matching `ensureFlashcardProgressAssignment`. Resulting assignment ID must match. Existing Flashcards flow (getProgressAssignmentId → ensureFlashcardProgressAssignment) still works and is unchanged. After Step 8 wires it, the Bridge Debug Log (LTI Launch Log section) will show `ensureAssignmentForCourse (Step 7)` with `result: found|created` and `assignmentId` when progress assignment is resolved.

### Step 8 — Refactor Flashcards to use ensureAssignmentForCourse **(Done)**

- **Scope:** Refactor `apps/api/src/course-settings/course-settings.service.ts`: change `getProgressAssignmentId` to call CanvasService.`ensureAssignmentForCourse` (or the new shared service) with the Flashcard Progress title and config (description, submissionTypes, pointsPossible, omitFromFinalGrade, etc.) instead of calling `ensureFlashcardProgressAssignment`. Optionally keep `ensureFlashcardProgressAssignment` as a one-liner that delegates to `ensureAssignmentForCourse` with Flashcard Progress config to avoid duplicating config. Ensure **Canvas OAuth token** and base URL are passed (from courseSettings getEffectiveCanvasToken and ctx). SubmissionService continues to call `getProgressAssignmentId` only; no change to SubmissionService in this step.
- **Test checkpoint:** Flashcards submission flow unchanged: complete a flashcard session and submit; progress is saved to the "Flashcard Progress" assignment. Course that never had the assignment gets it created. No regression in Teacher Settings or student progress.

---

## Phase C: Shared write submission body (Flashcards uses it first)

### Step 9 — Add writeSubmissionBody and expose getSubmission for callers **(Done)**

- **Scope:** Add to `apps/api/src/canvas/canvas.service.ts` a method `writeSubmissionBody(ctx: LtiContext, assignmentId: string, bodyContent: string, tokenOverride?: string | null): Promise<void>` that: **token is the Canvas OAuth token** — from tokenOverride (callers pass it from session/CourseSettingsService.getEffectiveCanvasToken) or throw if not provided; resolve base URL from ctx; call existing `createSubmissionWithBody(courseId, assignmentId, userId, bodyContent, domainOverride, token)`. Ensure `getSubmission` remains available on CanvasService (it already is). Document that tools that need to merge with existing must call `getSubmission` first, then call `writeSubmissionBody` with the final body. No changes to SubmissionService yet. Verification deferred until Step 10 wires Flashcards to use it.

### Step 10 — Refactor SubmissionService.saveProgressToCanvas to use writeSubmissionBody **(Done)**

- **Scope:** In `apps/api/src/submission/submission.service.ts`, refactor `saveProgressToCanvas`: (1) get progress assignment ID (unchanged: via courseSettings.getProgressAssignmentId, which now uses ensureAssignmentForCourse under the hood). (2) Get **Canvas OAuth token** (courseSettings.getEffectiveCanvasToken). (3) Call canvas.getSubmission(ctx.courseId, progressAssignmentId, ctx.userId, ...) to get existing body. (4) In Flashcards code: parseSubmissionBody, mergeDeckResult, build `bodyString = JSON.stringify({ results })`. (5) Call canvas.writeSubmissionBody(ctx, progressAssignmentId, bodyString, token). (6) Keep verification: re-fetch submission, parseSubmissionBody, assert hasOurDeck; leave verification in SubmissionService. Remove direct call to createSubmissionWithBody from saveProgressToCanvas.
- **Test checkpoint:** Flashcards submission: complete a session (tutorial and/or rehearsal), submit. Progress is saved to Flashcard Progress assignment; verification passes. Bridge Debug Log shows `saveProgressToCanvas (Step 10)` and `writeSubmissionBody (Step 10)`. Multiple decks and merge behavior unchanged. No regression. (Full E2E verification blocked by Test User 403 until real student or AGS.)

---

## Phase D: LTI 1.3 AGS (separate token; Flashcards must use it before Prompter)

### Step 11a — LtiAgsService: token acquisition only (JWT assertion)

- **Scope:** Create `apps/api/src/lti/lti-ags.service.ts` (and register in `apps/api/src/lti/lti.module.ts`). Implement only AGS access token acquisition: e.g. `getAgsAccessToken(ctx: LtiContext): Promise<string>`. **Canvas LTI 1.3 token requests require a signed JWT assertion**, not a client secret. Build a JWT signed with the tool's private key (LTI_PRIVATE_KEY): grant_type=client_credentials (or urn:ietf:params:oauth:grant-type:jwt-bearer), assertion=<signed JWT>, scope including AGS (e.g. `https://purl.imsglobal.org/spec/lti-ags/scope/score`). POST to the platform token endpoint (derived from ctx.canvasBaseUrl / LTI iss, e.g. `{iss}/login/oauth2/token`). Return the access_token from the response. Handle non-2xx and parse JSON safely. Do not implement lineitem resolution or score/result POST yet.
- **Test checkpoint:** Unit test with mocked fetch: for a given ctx (with canvasBaseUrl), the service builds the correct JWT assertion and calls the correct token URL with correct body/headers and returns the token from the mocked response. Failure response (4xx/5xx) throws or returns a clear error. No change to Flashcards or any other flow.

### Step 11b — LtiAgsService: lineitem resolution

- **Scope:** In `apps/api/src/lti/lti-ags.service.ts`, add lineitem resolution: e.g. `getLineitemUrl(ctx: LtiContext, accessToken: string): Promise<string>`. **Use the AGS URLs captured in Step 6:** (1) If `ctx.agsLineitemUrl` is set (single lineitem from launch JWT), return it. (2) Else if `ctx.agsLineitemsUrl` is set, GET that URL (with Bearer accessToken) and select the appropriate lineitem (e.g. by resourceLinkId or first); return the lineitem URL to which score will be POSTed. (3) If neither is set, fail with a clear error (AGS URLs must be captured at launch). Return the single lineitem URL. Unit-testable in isolation (mock token and platform responses).
- **Test checkpoint:** Unit test with mocked fetch: for a given ctx (with agsLineitemUrl or agsLineitemsUrl set) and accessToken, the service returns the lineitem URL or requests the lineitems endpoint and returns a lineitem URL. Handle empty list or error responses. No score POST yet.

### Step 11c — LtiAgsService: score POST to lineitem

- **Scope:** In `apps/api/src/lti/lti-ags.service.ts`, add score submission: e.g. `postScore(lineitemUrl: string, accessToken: string, userId: string, score: number, scoreMaximum: number): Promise<void>`. POST to the lineitem's results endpoint (or score endpoint per IMS AGS spec) with IMS JSON body (userId, scoreGiven, scoreMaximum). Use Bearer **AGS access token** (from Step 11a). Handle 2xx as success and non-2xx as failure. Then add or extend `submitGradeViaAgs(ctx, payload)` to call getAgsAccessToken, getLineitemUrl, postScore (and in a later step, optional result POST). For this step, `submitGradeViaAgs` only does token + lineitem + score POST; no resultContent yet.
- **Test checkpoint:** Unit test with mocked token and lineitem URL: postScore (or submitGradeViaAgs with score only) builds correct request body and headers and handles success/error. Manual test against Canvas with LTI 1.3 AGS enabled: call submitGradeViaAgs with test ctx and `{ score, scoreMaximum }` and confirm grade appears in Canvas. Flashcards flow still does not call AGS.

### Step 11d — LtiAgsService: optional result content POST **(Done, pending verification)**

- **Scope:** In `apps/api/src/lti/lti-ags.service.ts`, add optional result submission: e.g. POST result (content URL or text) to the AGS score as `comment` when `payload.resultContent` is provided. The IMS AGS score object supports a `comment` field (plain text); URLs are passed as strings and Canvas renders them as clickable. Integrate into `submitGradeViaAgs`: pass `resultContent` as the score `comment` when present.
- **Test checkpoint:** Unit test with mocked endpoints: when resultContent is passed, the service includes it in the score POST body as comment. Manual test (optional): submit grade with resultContent and verify in Canvas SpeedGrader. Flashcards flow does not pass resultContent; Prompter will use it in Step 13.

### Step 12 — Wire Flashcards to submitGradeViaAgs when graded (required) **(Done)**

- **Scope:** In `apps/api/src/submission/submission.service.ts`, in `submitFlashcard`, after successfully calling saveProgressToCanvas and when `isGraded` is true, call `ltiAgsService.submitGradeViaAgs(ctx, { score: points, scoreMaximum: 100 })`. Inject LtiAgsService into SubmissionService; ensure LtiModule (or the module that provides LtiAgsService) is imported where SubmissionService is used. If AGS is not configured or lineitem is missing, catch and log (or return partial success) so Flashcards still report progress saved. **This step is required** — the AGS path must be exercised end-to-end with Flashcards before building Prompter submission (Step 13). When progress save fails (e.g. REST 403), still attempt submitGradeViaAgs so the grade appears via AGS.
- **Test checkpoint:** Flashcards graded submission (rehearsal/screening with score) results in grade sent to Canvas via AGS when configured. Tutorial (not graded) does not call AGS. Progress save still works if AGS fails. No regression for ungraded or tutorial flows. Confirm in Canvas that the grade appears for the LTI 1.3 resource link.

---

## Phase E: Prompt Manager (only after Phases A–D and Step 12 verified with Flashcards)

### Step 13 — Prompter submission flow (when Prompt Manager is built)

- **Scope:** When implementing Prompt Manager submission, add a submission path (e.g. in SubmissionController or a Prompter-specific controller) that: (1) gets assignment ID via `ensureAssignmentForCourse(ctx, { title: '<Prompter assignment title>', description: '...', submissionTypes: ['online_text_entry'], ... })` — same shared function, Prompter's config. (2) Builds body string (Prompter schema: e.g. prompt snapshot, video URL, metadata). (3) Calls `writeSubmissionBody(ctx, assignmentId, bodyString)`. (4) Computes score (Prompter rules). (5) Calls `submitGradeViaAgs(ctx, { score, scoreMaximum: 1, resultContent: submissionUrl, resultFormat: 'url' })`. Do not add a separate find-or-create or submission implementation for Prompter — only call the same three shared functions with Prompter-specific parameters.
- **Test checkpoint:** Prompter submission writes to the correct assignment and sends grade/result via AGS; no duplicate logic for find-or-create or submission.

---

## Summary order

| Step | Phase | What | Status |
|------|--------|------|--------|
| 1 | A | LTI error HTML → `lti-error.util.ts` | Done |
| 2 | A | Redirect path → `lti-redirect.util.ts` (LTI 1.3 only) | Done |
| 3a | A | Extract persist context + redirect helper; wire into `launch13` only | Done |
| 4 | A | LTI 1.3 tool type mapping and default | Done |
| 5 | A | **Checkpoint:** Verify Prompter LTI 1.3 launch (session, SPA /prompter) | Done |
| 6 | A | Capture AGS lineitem/lineitems URLs in LtiContext at launch | Done |
| 7 | B | Add `ensureAssignmentForCourse` (OAuth token) | Done |
| 8 | B | Flashcards use it via `getProgressAssignmentId` | Done |
| 9 | C | Add `writeSubmissionBody` (OAuth token) | Done |
| 10 | C | Flashcards use it in `saveProgressToCanvas` | Done |
| 11a | D | LtiAgsService: token acquisition (JWT assertion, not client secret) | Done |
| 11b | D | LtiAgsService: lineitem resolution (uses ctx.agsLineitemUrl / agsLineitemsUrl) | Done |
| 11c | D | LtiAgsService: score POST to lineitem | Done |
| 11d | D | LtiAgsService: optional result content POST | Done (pending verification) |
| 12 | D | **Required:** Wire Flashcards to AGS; verify end-to-end before Step 13 | Done |
| 13 | E | Prompter submission uses same three shared functions | — |

After approval of this plan, implementation can proceed step by step with the stated checkpoints before moving on.
