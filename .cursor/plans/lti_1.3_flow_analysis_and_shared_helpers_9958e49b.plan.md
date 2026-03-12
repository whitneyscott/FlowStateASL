---
name: LTI 1.3 flow analysis and shared helpers
overview: Analysis of the complete LTI 1.3 flow in the Flashcards implementation from launch to grade passback, with per-step classification (purpose, file, tool-specific vs shared, generalization needs) and a proposed shared helper structure (extractions, names, locations) without writing code.
todos: []
isProject: false
---

# LTI 1.3 Flow Analysis and Proposed Shared Helper Structure

## End-to-end flow (launch to grade passback)

```mermaid
sequenceDiagram
  participant Canvas
  participant LtiController
  participant OidcStore
  participant Lti13Launch
  participant TokenStore
  participant Session
  participant SPA
  participant FlashcardController
  participant SubmissionController
  participant SubmissionService
  participant CanvasService
  participant CourseSettings

  Canvas->>LtiController: GET/POST oidc/login
  LtiController->>OidcStore: setOidcState
  LtiController->>Canvas: redirect auth URL
  Canvas->>LtiController: POST launch id_token+state
  LtiController->>OidcStore: consumeOidcState
  LtiController->>Lti13Launch: validateAndExtract
  Lti13Launch->>Lti13Launch: payloadToContext
  LtiController->>TokenStore: setLtiToken
  LtiController->>Session: ltiContext + save
  LtiController->>SPA: redirect /flashcards?lti_token
  SPA->>LtiController: GET context?lti_token
  LtiController->>TokenStore: consumeLtiToken
  LtiController->>Session: ltiContext + save
  LtiController->>SPA: LtiContext
  SPA->>FlashcardController: GET playlists etc cookie
  FlashcardController->>Session: ltiContext
  SPA->>SubmissionController: POST submission cookie
  SubmissionController->>Session: ltiContext
  SubmissionController->>SubmissionService: submitFlashcard ctx dto
  SubmissionService->>CourseSettings: getProgressAssignmentId
  SubmissionService->>CanvasService: createSubmissionWithBody progress
  Note over SubmissionService: submitGrade not called yet
```



---

## Step-by-step analysis

### Phase 1: OIDC login (Canvas to our app)


| Step                                                            | What it does                                                                                         | File                                                                                       | Tool-specific? | Generalization               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------- | ---------------------------- |
| Parse OIDC params (iss, login_hint, target_link_uri, client_id) | Reads query/body and normalizes param names                                                          | [apps/api/src/lti/lti.controller.ts](apps/api/src/lti/lti.controller.ts) `handleOidcLogin` | No             | None. Already tool-agnostic. |
| Validate required params, return 400 if missing                 | Checks iss, login_hint, target_link_uri, client_id, LTI_REDIRECT_URI                                 | Same                                                                                       | No             | None.                        |
| Generate state + nonce, store in OIDC store                     | `setOidcState(state, nonce, redirectUri, targetLinkUri)`                                             | [apps/api/src/lti/lti-oidc-state.store.ts](apps/api/src/lti/lti-oidc-state.store.ts)       | No             | None.                        |
| Build Canvas auth URL and redirect                              | URL on iss with scope, response_type, client_id, redirect_uri, state, nonce, response_mode=form_post | [apps/api/src/lti/lti.controller.ts](apps/api/src/lti/lti.controller.ts) `handleOidcLogin` | No             | None.                        |


### Phase 2: Launch (Canvas POST id_token + state)


| Step                                          | What it does                                                                                                                   | File                                                                                                      | Tool-specific? | Generalization                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Handle Canvas error/error_description in body | Returns 400 HTML error page                                                                                                    | [apps/api/src/lti/lti.controller.ts](apps/api/src/lti/lti.controller.ts) `launch13`                       | Partially      | `ltiErrorHtml` links to `/flashcards?debug=1`; should use a generic path or config (e.g. FRONTEND_URL only).                                 |
| Extract id_token and state, validate presence | 400 if missing                                                                                                                 | Same                                                                                                      | No             | None.                                                                                                                                        |
| Consume OIDC state                            | `consumeOidcState(state)`                                                                                                      | [apps/api/src/lti/lti-oidc-state.store.ts](apps/api/src/lti/lti-oidc-state.store.ts)                      | No             | None.                                                                                                                                        |
| Validate JWT and extract payload              | Fetches platform JWKS from iss, verifies signature/iss/aud/exp, optional dev fallback for small keys                           | [apps/api/src/lti/lti13-launch.service.ts](apps/api/src/lti/lti13-launch.service.ts) `validateAndExtract` | No             | None.                                                                                                                                        |
| Map JWT payload to LtiContext                 | Reads LTI claim URIs + custom (course_id, assignment_id, user_id, module_id, roles, tool_type); derives canvasBaseUrl from iss | [apps/api/src/lti/lti13-launch.service.ts](apps/api/src/lti/lti13-launch.service.ts) `payloadToContext`   | Partially      | Only tool-specific: `toolType = custom.tool_type === 'prompter' ? 'prompter' : 'flashcards'`. Could accept a mapping or default from config. |
| Optional: teacher prompter assignment sync    | If toolType===prompter and teacher, sync assignment name                                                                       | [apps/api/src/lti/lti.controller.ts](apps/api/src/lti/lti.controller.ts) `launch13`                       | Yes (Prompter) | Keep in controller as tool-specific post-step; no extraction.                                                                                |
| Create one-time token, store context          | `setLtiToken(token, ctx)`                                                                                                      | [apps/api/src/lti/lti-token.store.ts](apps/api/src/lti/lti-token.store.ts)                                | No             | None.                                                                                                                                        |
| Choose redirect path by toolType              | `path = ctx.toolType === 'prompter' ? '/prompter' : '/flashcards'`                                                             | [apps/api/src/lti/lti.controller.ts](apps/api/src/lti/lti.controller.ts) `launch13`                       | Yes            | Path should come from a small registry: toolType to SPA path (e.g. config or constant map).                                                  |
| OAuth redirect decision                       | If no session canvas token and OAuth configured, redirect to /api/oauth/canvas?returnTo=finalRedirect                          | Same                                                                                                      | No             | None.                                                                                                                                        |
| Save ltiContext to session, redirect          | session.save then res.redirect(finalRedirect or OAuth URL)                                                                     | Same                                                                                                      | No             | None.                                                                                                                                        |


### Phase 3: Context for SPA (first load with lti_token)


| Step                                        | What it does                                                                 | File                                                                                  | Tool-specific? | Generalization                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| Return context from session if present      | Read req.session.ltiContext                                                  | [apps/api/src/lti/lti.controller.ts](apps/api/src/lti/lti.controller.ts) `getContext` | No             | None.                                                                                         |
| Else consume lti_token and return context   | consumeLtiToken(token), optionally write to session, return context          | Same                                                                                  | No             | None.                                                                                         |
| Fallback when no session and no valid token | Return minimal standalone context (toolType: flashcards, userId: standalone) | Same                                                                                  | Partially      | Default toolType is hardcoded flashcards; could be config or leave as-is for unauthenticated. |


### Phase 4: Protected API calls (Flashcards)


| Step                                                                | What it does                                                                          | File                                                                                                 | Tool-specific?                                              | Generalization                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Guard: require session.ltiContext                                   | LtiLaunchGuard canActivate                                                            | [apps/api/src/lti/guards/lti-launch.guard.ts](apps/api/src/lti/guards/lti-launch.guard.ts)           | No                                                          | None.                                                                                                                           |
| Read ctx from session for flashcard playlists/items/config/progress | req.session.ltiContext (and canvasAccessToken)                                        | [apps/api/src/flashcard/flashcard.controller.ts](apps/api/src/flashcard/flashcard.controller.ts)     | No (context is shared)                                      | None. Flashcard-specific is the use of ctx (e.g. getConfig by courseId+resourceLinkId).                                         |
| POST submission: build full ctx and call submitFlashcard            | session ltiContext + canvasAccessToken to SubmissionService.submitFlashcard(ctx, dto) | [apps/api/src/submission/submission.controller.ts](apps/api/src/submission/submission.controller.ts) | Controller is shared; service method is Flashcards-specific | Submission controller could stay generic; different tools would call different service methods or a dispatcher by ctx.toolType. |


### Phase 5: Submission and grade passback (Flashcards)


| Step                                    | What it does                                                                          | File                                                                                                                  | Tool-specific?                                                                        | Generalization                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| calculateGrade(dto)                     | Tutorial to 0 / not graded; else percentage                                           | [apps/api/src/submission/submission.service.ts](apps/api/src/submission/submission.service.ts)                        | Flashcards-specific (tutorial vs rehearsal/screening)                                 | Any tool would have its own grading rules; could be a strategy or tool-specific service.                                                                                           |
| Resolve progress assignment for course  | getProgressAssignmentId (Flashcard Progress assignment)                               | [apps/api/src/course-settings/course-settings.service.ts](apps/api/src/course-settings/course-settings.service.ts)    | Flashcards-specific (assignment title and schema)                                     | Prompter would use different assignment or no progress assignment; keep in course-settings or tool-specific config.                                                                |
| Save progress to Canvas submission body | getSubmission, merge JSON results, createSubmissionWithBody                           | [apps/api/src/submission/submission.service.ts](apps/api/src/submission/submission.service.ts) `saveProgressToCanvas` | Flashcards-specific (schema: results by deckId, mergeDeckResult, parseSubmissionBody) | Progress schema and merge logic are tool-specific; only the get token, get/create assignment, GET submission, POST body pattern could be shared.                                   |
| LTI 1.1 grade passback                  | CanvasService.submitGrade(outcomeUrl, sourcedid, score, scoreTotal) XML replaceResult | [apps/api/src/canvas/canvas.service.ts](apps/api/src/canvas/canvas.service.ts)                                        | No (generic LTI Outcomes)                                                             | None. Not currently called from SubmissionService (stubbed). Would need ctx.lisOutcomeServiceUrl and ctx.lisResultSourcedid (LTI 1.1 only; Lti13LaunchService does not set these). |


---

## Proposed shared helper structure

### 1. LTI error HTML (generalize link)

- **Current:** [apps/api/src/lti/lti.controller.ts](apps/api/src/lti/lti.controller.ts) — `ltiErrorHtml(message, frontendUrl)`; debug link is `${frontendUrl}/flashcards?debug=1`.
- **Proposal:** Extract to a small helper used by LtiController. Either:
  - **Option A:** Move to `apps/api/src/lti/lti-error.util.ts` (or `lti-html.util.ts`) and pass a debug path argument (e.g. `/flashcards` or a generic `/` or from config). Name: `renderLtiLaunchErrorHtml(message: string, options?: { frontendUrl?: string; debugPath?: string })`.
  - **Option B:** Keep in controller but use `frontendUrl` only for the link (e.g. `${frontendUrl}?debug=1`) so the link is not Flashcards-specific.
- **Location:** New file under `apps/api/src/lti/` (e.g. `lti-error.util.ts`) if extracted; otherwise same file with a one-line change.

### 2. Redirect path by tool type

- **Current:** Inline in `launch13`: `const path = ctx.toolType === 'prompter' ? '/prompter' : '/flashcards'`.
- **Proposal:** Extract to a single place so adding a new tool is one edit. Options:
  - **Option A:** Constant map in lti.controller.ts or in a small module: `TOOL_TYPE_TO_SPA_PATH: Record<LtiContext['toolType'], string>` (e.g. `{ flashcards: '/flashcards', prompter: '/prompter' }`). Controller calls `getRedirectPathForToolType(ctx.toolType)` or uses the map.
  - **Option B:** Config (e.g. env or ConfigService): LTI_SPA_PATHS_FLASHCARDS, LTI_SPA_PATHS_PROMPTER or a single JSON. Prefer a code constant unless you need runtime config.
- **Name:** `getRedirectPathForToolType(toolType: LtiContext['toolType']): string` or `TOOL_TYPE_SPA_PATHS`.
- **Location:** `apps/api/src/lti/lti-redirect.util.ts` (or next to LtiController). If you later add more LTI helpers, a single `apps/api/src/lti/lti.util.ts` or `lti/constants.ts` could hold this and the error helper.

### 3. Session + token + redirect after successful launch (LTI 1.3)

- **Current:** In `launch13`: create token, setLtiToken, set session.ltiContext, session.save callback, then either OAuth redirect or finalRedirect. Duplicated pattern also in launchFlashcards and launchPrompter (LTI 1.1) with small differences (sync step only for prompter).
- **Proposal:** Extract a small helper that: (1) generates token and calls setLtiToken(ctx), (2) assigns req.session.ltiContext = ctx, (3) calls session.save(callback), (4) in callback: decides redirect URL (OAuth init vs finalRedirect) and calls res.redirect(url). The helper does not know about flashcards vs prompter; it receives ctx and finalRedirect (already computed from toolType). So the only extraction is the persist context and redirect logic.
- **Name:** `persistLtiContextAndRedirect(req, res, ctx, finalRedirect, options?: { oauthInitUrl?: string })` or `finishLtiLaunch`. Responsibility: persist context (token + session), then redirect to finalRedirect or to oauthInitUrl when appropriate.
- **Location:** `apps/api/src/lti/lti-launch-finish.util.ts` (or inside a thin LtiLaunchHandler service used by LtiController). Controller would still: compute finalRedirect (using the path map above), compute oauthInitUrl when needed, then call this helper. Keeps controller as orchestrator; helper is reusable for any tool.

### 4. LTI 1.1 context extraction (already shared, minor default)

- **Current:** [apps/api/src/lti/lti.service.ts](apps/api/src/lti/lti.service.ts) `extractContext(body)` returns LtiContext with a hardcoded default `toolType: 'prompter'` (overwritten by controller for flashcards/prompter).
- **Proposal:** Make default explicit and tool-agnostic: e.g. `toolType: 'flashcards' as const` in the service so LTI 1.1 behavior is default to flashcards unless overwritten by launch endpoint. No extraction of the function; it already lives in LtiService and is used by both launch endpoints. Optional: accept an optional defaultToolType parameter if you want launch/flashcards and launch/prompter to pass it explicitly.

### 5. LTI 1.3 payload to context (tool type mapping)

- **Current:** [apps/api/src/lti/lti13-launch.service.ts](apps/api/src/lti/lti13-launch.service.ts) `payloadToContext` sets `toolType = custom.tool_type === 'prompter' ? 'prompter' : 'flashcards'`.
- **Proposal:** Keep mapping in one place. Optionally generalize to a small mapping (e.g. allowed custom values to toolType) so adding a new tool is a single addition: e.g. `CUSTOM_TOOL_TYPE_TO_TOOL_TYPE: Record<string, LtiContext['toolType']>` with default flashcards. No need to extract to another file unless you add many tools; same method, configurable map is enough.

### 6. What not to extract (keep tool-specific)

- **AssessmentService.syncAssignmentNameIfNeeded** — Prompter-only; called from LtiController after context is built. Stays in controller (or an optional post-context hook per tool if you ever have more).
- **SubmissionService.submitFlashcard**, **calculateGrade**, **saveProgressToCanvas**, **parseSubmissionBody**, **mergeDeckResult** — Flashcards-specific. No extraction for reuse by Prompter; Prompter will have its own submission/grade flow. Option: later introduce a generic submit-and-optionally-pass-back-grade interface and implement it per tool (e.g. SubmitFlashcardHandler, SubmitPrompterHandler).
- **CourseSettingsService.getProgressAssignmentId** / Flashcard Progress assignment — Flashcards-specific. Prompter uses different assignments; no shared helper needed for progress assignment resolution.
- **CanvasService.submitGrade** — Already generic (LTI 1.1 Outcomes). No extraction; callers (e.g. SubmissionService) remain responsible for passing lisOutcomeServiceUrl/lisResultSourcedid when implementing grade passback.
- **LtiLaunchGuard** — Already shared; no change.
- **Token and OIDC stores** — Already shared; no change.

### 7. Suggested file layout (new/renamed files only)

- `apps/api/src/lti/lti-error.util.ts` — `renderLtiLaunchErrorHtml(message, options?)` (optional debug path).
- `apps/api/src/lti/lti-redirect.util.ts` (or `lti/constants.ts`) — `TOOL_TYPE_SPA_PATHS` and/or `getRedirectPathForToolType(toolType)`.
- `apps/api/src/lti/lti-launch-finish.util.ts` — `persistLtiContextAndRedirect(req, res, ctx, finalRedirect, options?)` to centralize token + session persist and redirect (and optional OAuth redirect).

Controller and Lti13LaunchService stay where they are; they call these helpers/constants so that tool-specific behavior (which path, which error link) is configured in one place and the rest is reusable by any tool.

---

## Summary: shared vs tool-specific


| Component                                               | Today                               | After proposal                                                         |
| ------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| OIDC login (handleOidcLogin)                            | Shared                              | Shared (no change)                                                     |
| OIDC state store                                        | Shared                              | Shared (no change)                                                     |
| JWT validateAndExtract / payloadToContext               | Shared (toolType from custom)       | Shared; optional map for tool_type to toolType                         |
| Token store                                             | Shared                              | Shared (no change)                                                     |
| Session + redirect after launch                         | Shared but inline                   | Shared helper persistLtiContextAndRedirect                             |
| Redirect path by toolType                               | Hardcoded in controller             | Shared getRedirectPathForToolType or TOOL_TYPE_SPA_PATHS               |
| LTI error HTML                                          | Link to /flashcards                 | Shared renderLtiLaunchErrorHtml with configurable debug path           |
| LtiLaunchGuard                                          | Shared                              | Shared (no change)                                                     |
| getContext (session/token/fallback)                     | Shared; fallback default flashcards | Shared; optional config for fallback toolType                          |
| submitFlashcard / saveProgressToCanvas / calculateGrade | Flashcards                          | Remain Flashcards-specific                                             |
| submitGrade (Canvas LTI Outcomes)                       | Generic, not wired                  | Remain in CanvasService; call from tool-specific flow when implemented |
| Teacher sync (syncAssignmentNameIfNeeded)               | Prompter                            | Remain Prompter-specific in controller                                 |


