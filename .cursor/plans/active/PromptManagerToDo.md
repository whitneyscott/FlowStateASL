# Prompt Manager Todo

## Context (Apr 2026 — what we were sorting out)

- **Unifying Flashcards + Prompt Manager** at the **platform** level (one LTI stack, `toolType`, shared launch/session/API shell) is largely in place; the two tools stay **different student experiences** (flashcard flow vs timer/recording flow).
- **Where discussion got stuck** was **Prompt Manager student submission + Canvas**: how video/text actually reaches the assignment (deep link vs REST + token), **wrong launch context** when students use the wrong link, and **module layout** (two items: tool + assignment)—**not** building a single combined student UI for both tools.

## Scope Rules

- Preserve current Prompt Manager UX and visual style from `ASLexpressPromptManager/dev2/*`.
- Move presentation to CSS files (no inline style attributes for app UI).
- Keep behavior parity first, then optimize/refactor.

## Bridge Debug Log (Required for Future Work)

Every new Prompter API step MUST emit to the Bridge Debug Log via `appendLtiLog`:

- Use `appendLtiLog('prompt', '<step>', { ... })` from `apps/api/src/common/last-error.store.ts`
- Include step name, result (success/failure), key identifiers (courseId, resourceLinkId, assignmentId)
- Polled by BridgeLog component via `GET /api/debug/lti-log`

---

## Completed (v1 Migration)

- **LTI + Roles + Launch:** LTI 1.3 launch, teacher role detection, route guards, session handling
- **Teacher Config:** GET/PUT `/api/prompt/config`, TeacherConfigPage (minutes, prompts, access code, assignment name)
- **Student Access Control:** `POST /api/prompt/verify-access`, blocked attempts (3), teacher reset
- **Recording Workflow:** TimerPage (warm-up, preflight, MediaRecorder, submit)
- **Submission:** `POST /api/prompt/submit`, `POST /api/prompt/upload-video`, prompt-first + Canvas upload
- **Canvas Integration:** `ensureAssignmentForCourse`, `writeSubmissionBody`, `submitGradeViaAgs`
- **Teacher Viewer:** TeacherViewerPage (submissions list, video+prompt, grade, reset student)
- **ToolSelector:** Timer, Config, Grade links when `toolType === 'prompter'`

---

## Remaining / Future

### Course module placement (decided — keep it simple)

**Do this:** Put **two** things in the module for students: **LTI Prompter** (record) + **submission assignment** (due date / graded hand-in / correct context for `homework_submission` deep link where you use it). One tool-only link is fragile because launch context differs (resource vs `LtiDeepLinkingRequest`, assignment id from nav — see [LESSONS_LEARNED.md](LESSONS_LEARNED.md)).

**Automation (Nest):** When a teacher saves Prompt Manager config with a **Module** selected, the API adds the **assignment** to the module (existing) and **`syncPrompterLtiModuleItem`** adds an **ExternalTool** row whose launch URL includes `assignment_id=…` so the Prompter opens in assignment context. Tool id is resolved via **`LTI_PROMPTER_CLIENT_ID`** + `GET .../external_tools?include_parents=true`, or optional **`CANVAS_PROMPTER_EXTERNAL_TOOL_ID`** in `.env`. Teachers may need to **re-authorize Canvas OAuth** so the token includes `url:GET|/api/v1/courses/:course_id/external_tools`.

**Naming:** Clear titles + short assignment instructions beat clever Canvas locks.

**Enforcement (pragmatic — good enough vs GoReact-style lock-in):**

- Do **not** count on **module requirements** across all schools/teachers.
- **Prefer** a documented teacher setup: submission path matches **LTI / homework_submission** (or your supported pattern) so “random native upload” isn’t the happy path.
- **Fallback:** grading policy + viewer: submissions missing your expected prompt/ledger shape → incomplete or manual review (already directionally supported by API payload).

### Parking lot (technical)

- **Done (Nest):** `getEffectiveCanvasToken(courseId, sessionToken)` — session OAuth first, else encrypted `course_settings.canvas_api_token` for that `courseId` only (no shared env tokens). Teacher OAuth is persisted per course; manual token path also persists. Prompter reads/submit/upload/viewer use this; **teacher-only** `putConfig` and create-assignment/module/group still require session OAuth only where enforced. Video upload uses Canvas `.../submissions/{userId}/files` init (PHP parity). `writeSubmissionBody` uses `as_user_id` when the token holder is not the student, with auth-style retry flip.

### Teacher Config Enhancements

- [x] Full assignment options UI: points, assignment group, rubric, due/unlock/lock, attempts
- **Declined — prompt row “reorder” (drag/up-down):** the text **pool is a question bank**, not an ordered script. Each student is meant to get **one** prompt drawn from the set; row order in the config UI is not a teaching-sequence feature, so reorder controls are out of scope.
- [ ] Rich text for prompts (Quill or equivalent)

### Recording + Submit Enhancements

- [ ] Side-by-side compare view: source prompt + student recording playback
- [ ] Re-record before submit
- [ ] Retry/backoff for upload failures (exponential backoff UI)

### Viewer Enhancements

- [ ] Time-linked annotation/comments (add/edit/delete from viewer UI)
- [ ] Rubric assessment UI when assignment has rubric

### Styling Migration (Stage 7)

- [ ] Extract inline styles into CSS modules; match reference visual style
- [ ] Layout columns, timer card, prompt blocks, recording controls, viewer panels
- [ ] Responsive pass for student and teacher views

### Reliability + Security + QA (Stage 8)

- [ ] CSP and media permission checks for iframe/LTI context
- [ ] Smoke tests: teacher config, access code flow, recording+submit, teacher review
- [ ] Deployment checklist (Nest/React Prompt Manager)
- [ ] E2E verification: Launch from Canvas → config → record → submit → grade → verify in Canvas gradebook

### Open Decisions (Resolved)

- **Assignment source:** Use `ctx.assignmentId` when launched from Assignment; else `ensureAssignmentForCourse` with title "Prompt Manager Submissions".
- **Session storage:** Use `assignment_prompts` and `student_resets`; no separate `prompter_sessions`.
- **resultContent:** Sent via AGS as comment (URL or text) for Submission Review.

---

## Deferred (Not in v1)

- [ ] AI-generated feedback/scoring for recordings
