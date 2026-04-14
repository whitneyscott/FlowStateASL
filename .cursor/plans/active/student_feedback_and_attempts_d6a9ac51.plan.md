---
name: Student feedback and attempts
overview: "Ledger and prompt-storage quiz are removed entirely (not optional). Submission body (+ minimal upload metadata in comments if Canvas requires) must reliably supply prompts for teacher and student viewers. Then: student feedback + multi-attempt gate, rubric auto-comments, unlimited attempts, Sprout reference (rubric prompt as blue link → modal during playback). Flashcard/Prompt Manager backup announcements: delayed_post_at +10y on create."
todos:
  - id: remove-quiz-ledger-mandatory
    content: "Mandatory removal: quiz paths + ledger + promptLedgerAssignmentId (only in prompt.service.ts blob type ~60, ensureLedger read/write ~517/~554—remove entirely, no conditional reads). Same slice as body-first prompts. Remove /api/quiz, QuizModule, ensureLedgerAssignment, ledger submit/getSubmissions blocks."
    status: pending
  - id: api-my-submission
    content: Add GET /api/prompt/my-submission (or merge into config) that returns assignment allowed_attempts + self submission snapshot (body, comments, rubric_assessment, video URL) using student-capable Canvas token; define failure modes when only teacher token exists.
    status: pending
  - id: timer-gate-ui
    content: "TimerPage: my-submission gate; chooser vs auto-feedback; Section 2 -1 unlimited UX (copy, never block new attempt on count, no finite meter)."
    status: pending
  - id: student-feedback-ui
    content: "Implement StudentFeedbackPhase/viewer: deck timeline + submission video + rubric rows + timestamped comments; extract shared deck/rubric parsing from TeacherViewerPage where practical."
    status: pending
  - id: rubric-prompt-comments
    content: "Rubric comments: ALLCAPS + optional \": \" + teacher text; clamp with CANVAS_RUBRIC_CRITERION_COMMENT_MAX_CHARS (8192). buildRubricAssessmentPayload + save path."
    status: pending
  - id: storage-body-only
    content: "Body canonical + mandatory re-PUT same JSON via writeSubmissionBody after every successful uploadVideo attach; slim upload comment to metadata only; resolveDeckTimeline + getSubmissions + getMySubmission prefer body then legacy comments—never quiz/ledger."
    status: pending
  - id: unlimited-attempts
    content: TeacherConfigPage checkbox + API validation + putConfig/canvas update path for allowed_attempts=-1; adjust any retry logic that assumes finite attempts.
    status: pending
  - id: sprout-modal
    content: "Sprout reference: during video playback (teacher + student feedback UIs), render rubric-mapped prompt as a link (blue, underline/hover per app link styles); click opens modal with Sprout embed. Incorrect rows only unless spec changes; expose sproutAccountId safely."
    status: pending
  - id: settings-announcement-delayed
    content: "Backup announcements: POST with delayed_post_at +10y via createSettingsAnnouncement. **Pre-check (mandatory):** in a dev course, create test announcement with delayed_post_at, then run same discovery path as findSettingsAnnouncementByTitle + student GET used by course-settings; if topic missing from list, abort delayed_post_at strategy and document fallback."
    status: pending
isProject: false
---

# Prompter fixes: deprecated Canvas objects, student feedback, body-only prompts, rubric comments

## Priority order (your stack rank)

1. **Submission body–canonical prompts + delete quiz/ledger entirely** — one shippable slice: verify/fix submit + upload so the prompt always lives on the submission, **then** remove every quiz/ledger code path (no feature flag, no runtime fallback).
2. **Student access to feedback** when multiple submissions are allowed (chooser + single-attempt auto-viewer).
3. **Rubric criterion comments** auto-filled with the prompt text for each row (alongside free-form feedback text).
4. **Unlimited attempts** (`-1`) **+ Sprout reference** (link-styled rubric prompt → modal during playback) in teacher and student feedback UIs.

---

## 1) Stop deprecated quiz + ledger-style Canvas churn (critical)

### What the code does today (so we remove the right calls)

| Mechanism | Where | Purpose (legacy) |
|-----------|--------|-------------------|
| **Prompt storage quiz** | [`QuizService.ensurePromptStorageQuiz`](apps/api/src/quiz/quiz.service.ts) — one quiz per course titled `ASL Express Prompt Storage`; `quiz_type: 'assignment'` | Old channel to store which prompt a student saw |
| **One essay question per prompter assignment** | [`ensureQuestionForAssignment`](apps/api/src/quiz/quiz.service.ts), invoked from [`putConfig`](apps/api/src/prompt/prompt.service.ts) ~1443–1448 | Adds rows to that quiz — **many assignments ⇒ many questions**, which can overwhelm Canvas quiz/assignment UIs |
| **Per-submit quiz answers** | [`submit` → `quiz.storePrompt`](apps/api/src/prompt/prompt.service.ts) ~2460–2467 | Writes prompt HTML into quiz submission for that student |
| **Prompt ledger assignment** | [`ensureLedgerAssignment`](apps/api/src/prompt/prompt.service.ts) ~510–567; **`submit` ~2424–2457** and **`getSubmissions` ~3031** | Separate Canvas assignment for append-only JSON “ledger” rows — **important:** loading the teacher submissions list can still **create** the ledger assignment if missing, which adds to assignment bloat |
| **Settings blob assignment** | [`ensurePromptManagerSettingsAssignment`](apps/api/src/prompt/prompt.service.ts) ~570–594 | Still needed for storing Prompt Manager JSON in an assignment description unless migrated |

### Decision: ledger and quiz are **deprecated and removed** (mandatory)

**Policy:** There is **no** production fallback to quiz or ledger after this work. Prompts for grading and student feedback come **only** from the **student’s Canvas submission** (body as canonical, plus parsing of older submission comments for backwards compatibility until data ages out). Prompt Manager **settings** remain for **teacher config**, not per-attempt prompt history.

**Code to delete (not disable):**

- **Ledger:** the write block on [`submit`](apps/api/src/prompt/prompt.service.ts) ~2418–2457; the entire read/correlate block in [`getSubmissions`](apps/api/src/prompt/prompt.service.ts) ~3029–3088; **`ensureLedgerAssignment` and any path that creates the ledger assignment**; remove **`promptLedgerAssignmentId`** from the Prompt Manager settings blob type and from all read/write/merge paths.
- **Quiz:** [`putConfig`](apps/api/src/prompt/prompt.service.ts) calls to `ensurePromptStorageQuiz` / `ensureQuestionForAssignment`; [`submit`](apps/api/src/prompt/prompt.service.ts) `storePrompt`; quiz fallbacks in `getSubmissions` ~3167–3174 and [`getMySubmission`](apps/api/src/prompt/prompt.service.ts) ~3387–3392; [`QuizController`](apps/api/src/quiz/quiz.controller.ts) `/api/quiz/*`; [`QuizModule`](apps/api/src/quiz/quiz.module.ts) import from [`PromptModule`](apps/api/src/prompt/prompt.module.ts) and [`AppModule`](apps/api/src/app.module.ts); remove [`QuizService`](apps/api/src/quiz/quiz.service.ts) and Canvas quiz helpers in [`CanvasService`](apps/api/src/canvas/canvas.service.ts) that exist only for this feature.

### `promptLedgerAssignmentId` audit (remove unconditionally)

**Repo scan:** The key appears **only** in [`apps/api/src/prompt/prompt.service.ts`](apps/api/src/prompt/prompt.service.ts): optional field on the settings blob interface (~60), read in `ensureLedgerAssignment` (~517), written when persisting the ledger id (~554). **No other files** reference it.

**Required action:** Delete the property from the TypeScript blob interface and from every object built for `updateAssignmentDescription`. **Do not** gate on “if present then use”—remove the field and all `ensureLedgerAssignment` logic together. When teachers next save Prompt Manager config, the serialized blob simply **drops** the key (no special migration branch).

**Hard dependency (must pass before ship):** Section **3** — body-first resolution and a verified submit/upload pipeline (including **re-PUT submission body after upload** if Canvas clears it) so `promptHtml` is **always** recoverable from the submission with **zero** quiz/ledger calls.

**Existing Canvas junk:** Release notes: instructors may manually delete old “ASL Express Prompt Storage” quizzes and the hidden ledger assignment; optional cleanup script later — not a substitute for deleting code paths.

---

## 2) Student entry: feedback when multiple submissions allowed

[`TimerPage`](apps/web/src/pages/TimerPage.tsx) must not always jump into a new recording session; add **my submission** API + **View feedback** vs **Start another attempt** when attempts remain; **auto-open feedback** when `allowedAttempts === 1` and a submission exists.

### `allowed_attempts === -1` (unlimited) — UX rules (explicit)

- **Copy:** Any UI that shows attempt counts must display **“Unlimited attempts”** (not “NaN remaining” or blank). Do not show a finite “N attempts left” meter.
- **Chooser:** When a submission already exists, still show **View feedback** vs **Start another attempt**; **never** disable “Start another attempt” solely because of an attempt ceiling (there is none). Canvas remains authoritative if it ever rejects a submit; surface that error as a rare failure path.
- **Single-attempt:** `allowedAttempts === 1` unchanged: auto-route to feedback viewer when a graded/submitted row exists; no “new attempt” unless Canvas/teacher workflow allows resubmit.
- **Finite N > 1:** Show “Attempts remaining: **k**” where `k = max(0, allowedAttempts - submission.attempt)` using Canvas `attempt` integer; when `k === 0`, hide “Start another attempt” and only offer feedback (or read-only message per Canvas state).

---

## 3) Submission body–only prompt storage (careful)

**Note:** You did not ask for two intentional copies of the prompt. Today the **body** is written in `submit` and **post-upload JSON comments** may still carry `deckTimeline` because the teacher UI documents Canvas sometimes clearing body after file upload ([`TeacherViewerPage` `resolveDeckTimeline`](apps/web/src/pages/TeacherViewerPage.tsx) ~64–104)).

**Sequence:**

1. **Primary:** Keep canonical `deckTimeline` / `promptSnapshotHtml` in the submission **body** JSON (as today on `submit` via [`writeSubmissionBody`](apps/api/src/canvas/canvas.service.ts)).
2. **Post-upload:** After `attachFileToSubmission` completes successfully in [`uploadVideo`](apps/api/src/prompt/prompt.service.ts), **always** call **`writeSubmissionBody` again** with the **same** canonical JSON string (re-PUT) so the body is repopulated if Canvas cleared or replaced it when the file attached. This is the **mandatory** fallback—**not** optional and not “only if body empty” in code; always re-PUT, then optimize later if profiling shows redundancy on instances that preserve body.
3. **Upload JSON comment:** Slim to **non-prompt** metadata only (`durationSeconds`, `mediaStimulus`, typed `fsaslKind` if needed)—**no** `deckTimeline` in comments once body + re-PUT are verified stable.
4. **Readers:** [`resolveDeckTimeline`](apps/web/src/pages/TeacherViewerPage.tsx) / server aggregators **prefer submission `body`**, then legacy comments for old rows.

**Caveat:** Canvas often shows submission **body** to the learner in native UI; if that is undesirable, surface prompts only inside the LTI tool and keep body minimal or structured for machines.

**Ties to priority 1:** Quiz and ledger removal **ships in the same slice** as verified body-first prompt recovery (see todo `remove-quiz-ledger-mandatory` + `storage-body-only`).

---

## 4) Rubric criterion comments — auto-inject prompt per item

**Goal:** For each rubric row tied to a deck/text prompt, set Canvas `rubric_assessment[<criterion>].comments` so students see the item and any teacher note in one string.

**Format (required):**

1. Take the prompt line for that criterion (deck title, YouTube label clip text, or text-mode prompt string).
2. Normalize to **ALL CAPS** (Unicode `toUpperCase` / locale-aware if you standardize on `en-US` for ASL gloss consistency).
3. If the teacher entered **freeform comments** for that criterion (non-empty after trim): set `comments` = **`PROMPT_ALL_CAPS + ": " + teacherText`** (single Canvas `comments` string).
4. If there is **no** teacher freeform: set `comments` = **`PROMPT_ALL_CAPS` only** (no trailing `": "`).

**Hook points:** [`buildRubricAssessmentPayload`](apps/web/src/pages/TeacherViewerPage.tsx) ~351–379 and the rubric save path that calls [`putSubmissionGrade`](apps/api/src/canvas/canvas.service.ts): when assembling `comments` per criterion, apply the format above so the payload Canvas receives matches this spec.

- **Deck mode:** map criterion → deck index via `rubricCriterionDeckIndex`; source string = timeline row `title` (or agreed YouTube label).
- **Text mode:** map criterion index to `prompts[idx]` when dimensions align.

**Canvas rubric comment length (implementation constant):** Define and use a single shared constant, e.g. **`CANVAS_RUBRIC_CRITERION_COMMENT_MAX_CHARS = 8192`**, in the web (and API if server assembles strings) layer. **Clamp** the final assembled `comments` string to this length **before** `putSubmissionGrade`. *Rationale:* Canvas long-text fields commonly align with multi-KB limits; public Submission APIs often cite 8192 for related free-text. **If** a test `PUT` returns 4xx on an 8192-byte boundary on your host, lower once to the next verified safe value and update the constant.

Truncate safely: prefer dropping from the **ALL CAPS prompt portion** while preserving **teacher suffix** after `": "` when both are present.

---

## 5) Unlimited attempts + Sprout reference (retained)

### Unlimited attempts

- [`TeacherConfigPage`](apps/web/src/pages/TeacherConfigPage.tsx) + [`PromptController`](apps/api/src/prompt/prompt.controller.ts) allow `-1`; [`putConfig`](apps/api/src/prompt/prompt.service.ts) retry path reviewed for `-1`.

### Sprout reference modal (teacher + student)

**Context:** While **video playback** is available (teacher grading viewer and student feedback viewer), students and teachers should open the Sprout “correct answer” clip without leaving the page.

**Interaction:**

- In the **rubric** UI, the **prompt label** for a row that is **incorrect** (see below), is **deck-mapped**, and has a Sprout `videoId`, is rendered as a **link**, not plain text: use semantic link styling (**blue** foreground, underline on hover/focus, keyboard accessible) consistent with existing app link conventions (reuse shared class or design tokens from [`TeacherViewerPage`](apps/web/src/pages/TeacherViewerPage.tsx) / Prompter CSS — avoid inventing a new color).
- **Click** (or Enter on focused link) **opens a modal** containing the Sprout iframe embed (`videos.sproutvideo.com/embed/...` with `sproutAccountId` from config / grading payload).

**“Incorrect row” (concrete):** A deck-mapped rubric row is **incorrect** when the **assessed points for that criterion are strictly less than the criterion’s maximum points** from the Canvas rubric definition (`RubricCriterion.points` in [`TeacherViewerPage.tsx`](apps/web/src/pages/TeacherViewerPage.tsx) ~255–260, ~1338–1371). Use the same source as the UI: `rubricDraft[critId]?.points ?? assess?.points` compared to `c.points` after a rating is selected (if **unrated**, do **not** show the Sprout link as “incorrect”—no rating means unknown). Optional refinement: if all ratings share the same max, `earned < max` matches “not full credit.”

**Scope:** Only show the Sprout link for rows that are **incorrect** by the rule above **and** have a non-empty Sprout `videoId` on the mapped deck timeline entry.

**Data:** Expose `sproutAccountId` only where needed for embed URL assembly; do not log full account id in bridge logs at info level.

---

## 6) Testing / rollout

- Confirm **no** Canvas API calls create quizzes, ledger assignments, or quiz questions; assignment list / module UI loads without loops.
- Student OAuth vs teacher-token-only messaging.
- Single / multi / unlimited attempts; deck + text + YouTube stimulus; **-1** shows “Unlimited attempts” and never blocks “Start another attempt” on count alone.
- Rubric save: student sees criterion comments + SpeedGrader parity; verify `ALLCAPS` / `ALLCAPS: teacher` formats.
- Regression: teacher viewer prompt source after quiz/ledger removal.
- After `uploadVideo`: confirm **second** `writeSubmissionBody` ran and GET submission shows canonical JSON in `body` (or document Canvas anomaly).
- Sprout: rubric prompt link looks like a real link (blue); modal opens from click during playback contexts; link only on **incorrect + videoId** rows.
- Settings announcements: delayed_post_at **pre-check** (Section 7) passes on target Canvas before enable.

```mermaid
flowchart TD
  p3[Body_first_prompt_verify]
  p1[Delete_quiz_ledger_code]
  p2[Student_feedback_gate]
  p4[Rubric_auto_comments]

  p3 --> p1
  p2 --> p4
  p1 --> p4
```

---

## 7) Settings backup announcements — delayed availability (10 years)

**Goal:** When Canvas **announcements** are **created** as the backup mirror for **Flashcard** and **Prompt Manager** settings (not on every message update unless you choose to), set their **go-live** time far in the future so instructors and students are not spammed with a visible “new announcement” while the app continues to read/write the topic body over the API.

**Where today:** [`CanvasService.createSettingsAnnouncement`](apps/api/src/canvas/canvas.service.ts) (~2939–2965) POSTs `{ title, message, is_announcement: true }` only. [`createFlashcardSettingsAnnouncement`](apps/api/src/canvas/canvas.service.ts) (~3003–3015) delegates to it. Prompt Manager calls the same helper when creating the “DO NOT DELETE” announcement in [`putConfig`](apps/api/src/prompt/prompt.service.ts) ~1489–1495.

**Implementation sketch:** Extend `createSettingsAnnouncement` (or callers) to include Canvas’s **`delayed_post_at`** (ISO8601) = **current time + 10 years** (UTC, stable clock skew). See [Discussion Topics API](https://canvas.instructure.com/doc/api/discussion_topics.html).

### Mandatory pre-check: delayed topic discoverability (before shipping)

Run **once per Canvas host** (script or manual + document in README):

1. `POST /api/v1/courses/:course_id/discussion_topics` with `title` = unique test string, `message` minimal, `is_announcement=true`, **`delayed_post_at`** = now + 1 year (or +10y), using a course token with announcement create rights.
2. Capture returned `id`.
3. **Discovery:** Call the **same code path** production uses: paginated `GET .../discussion_topics?only_announcements=true` matching [`findSettingsAnnouncementByTitle`](apps/api/src/canvas/canvas.service.ts) until the test title is found or pages exhaust.
4. **Student read path:** If student settings load uses a different fetch (e.g. by id or search), repeat that path for the test topic.
5. **Pass criteria:** Topic **must** be findable and readable for settings sync. **If any step fails:** do **not** ship `delayed_post_at` for backup announcements on that host; keep immediate post and document limitation (or alternate mitigation).

**Scope note:** Independent of quiz/ledger work; can ship in the same or a separate PR.
