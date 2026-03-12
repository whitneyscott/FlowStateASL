# Prompt Manager To-Do

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

### Teacher Config Enhancements

- [ ] Full assignment options UI: points, assignment group, rubric, due/unlock/lock, attempts
- [ ] Prompt reorder (drag-and-drop or up/down)
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
