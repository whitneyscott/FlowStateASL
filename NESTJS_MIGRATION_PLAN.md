# ASL Express: NestJS Migration Plan
## Critical Evaluation & Revised Architecture

---

## Plan Evaluation Against Three Goals

### Goal 1 — Resilient Submission (Sentinel Buffer)

**Finding: Two gaps that break 100% recovery.**

**Gap A — Grade data lost on retry.** The `assessment_sessions` table has no `score`
or `score_total` columns. `SubmissionService.retryFailed()` has no local source for
the grade to resubmit. Fix: add `score INTEGER` and `score_total INTEGER` to
`assessment_sessions`. Grade is written at Step 1 (local save), so retry always
has everything it needs.

**Gap B — Video file not protected.** The plan protects Canvas grade API failures
but says nothing about the video file upload. A 5-minute recording is a large blob.
If the upload connection times out, the video lives only in the browser's memory —
it is permanently lost. Initial fix proposed: save blob to Cloudflare R2 first;
add `video_url` and `video_sync_status` columns.

**Gap B — Subsequently revised.** R2 intermediate storage was eliminated. Instead:
(a) `assessment_sessions` is a transactional outbox — deleted on Canvas success;
(b) video is uploaded in chunks directly to Canvas's own file upload endpoint;
(c) `canvas_file_id` is stored as a checkpoint once the file is on Canvas, enabling
retry to skip re-upload if only the assignment submission or grade step failed;
(d) if the upload itself fails, the student re-uploads from the MediaRecorder blob
persisted to IndexedDB in `RecorderPanel.tsx`. This eliminates cloud storage costs
and keeps Canvas as the single source of truth for completed submissions.

**Gap C — `pending` is ambiguous.** A row is `pending` for two different reasons:
(a) student opened session but never submitted, (b) student submitted but Canvas
API failed. Distinguishing them matters for the recovery panel — you do not want
to show teachers sessions that students simply abandoned. Fix: the existing
`submitted_at` column already resolves this. If `submitted_at IS NULL` → session
open but not submitted (not shown in recovery panel). If `submitted_at IS NOT NULL`
AND `sync_status = 'pending'` → submitted locally, Canvas sync outstanding.

**Finding: `assignment_prompts` table is redundant.** The plan has both
`assignment_prompts` (legacy from PHP) and `assessment_sessions.prompt_snapshot_html`.
Both store the same Quill HTML. `ISessionRepository` wraps `assignment_prompts`,
but `SubmissionService` writes directly to `assessment_sessions`. Remove
`assignment_prompts`, `ISessionRepository`, and `StudentResetEntity`. Consolidate
all session data into `assessment_sessions`. This eliminates one DB table, one
repository interface, one token, one entity — and the split-brain risk of the same
snapshot in two places. `student_resets` is a PHP legacy with no role in the
Sentinel Buffer; defer it entirely.

Revised token count: **2 tokens** (not 3).
```
CONFIG_REPOSITORY      ← prompt_configs (teacher config, UPSERT)
ASSESSMENT_REPOSITORY  ← blocked_attempts (fingerprint blocking)
```
`assessment_sessions` is owned directly by `SubmissionService` because its sync
lifecycle is not swappable — the outbox always exists regardless of LTI version.

---

### Goal 2 — Contextual Access Points

**Finding: Plan is correct. No changes needed.**

`POST /api/lti/launch/flashcards` and `POST /api/lti/launch/prompter` are distinct.
`toolType` in session drives `AppRouter.tsx`. LTI context never touches query strings.
The `LtiContext` interface is clean — Canvas IDs only, no institutional fields.

---

### Goal 3 — Assessment Bridge

**Finding: Correct in structure, one clarification needed.**

The plan correctly defers the full Bridge (Phases D–F) until flashcards work (Phase C).
One addition: the teacher viewer needs to render `selectedCardsHtml` as **titles only**,
not live SproutVideo iframes. The teacher is grading a completed recording — they do
not need the videos to play. Rendering iframes in the viewer creates iframe sandboxing
issues and slows the page. The `selectedCardsHtml` generator should produce
`<div class="card"><h3>{title}</h3><p>{unit_code}</p></div>` rather than embed codes.
SproutVideo embeds belong in the student-facing `PromptDisplay` only.

---

### Q3 — React Component Library Recommendation

**Recommendation: Tailwind CSS + `react-player` only. No component library.**

Reason: The core UI surface is the HTML viewer. It renders raw Quill output via
`dangerouslySetInnerHTML`. Any pre-styled component library (MUI, Mantine, Chakra)
will ship CSS that fights Quill's output — heading sizes, list styles, font weights.
This produces exactly the "formatting hot mess" the requirement explicitly prohibits.

The correct stack:
- **Tailwind CSS** — utility classes for layout, no CSS conflicts with rendered HTML
- **`react-player`** — video playback in `RecorderPanel` (wraps MediaRecorder and video element cleanly)
- **No UI component library** — build `WarmupTimer`, `RecoveryPanel`, etc. as plain Tailwind components

This is faster to build because there is no framework API to learn, no version
conflicts, and no fighting a component library's opinions about what a button looks
like inside a grading viewer.

---

### Q4 — LTI 1.3 Readiness: Flaw in Swap Mechanism

**Finding: `STORAGE_BACKEND=lti13` conflates Canvas auth with local storage. This
is wrong and would break the outbox.**

The current plan implies `STORAGE_BACKEND=lti13` means "replace Postgres storage
with LTI 1.3 Canvas-side storage." But that would eliminate the outbox —
defeating Goal 1 entirely. Canvas AGS does not retry failed grade submissions for
you. The outbox must survive the LTI 1.3 migration.

What actually changes between LTI 1.1 and LTI 1.3:
- **Canvas authentication**: Bearer token → JWT signed with RSA key, sent to AGS
  line item endpoint
- **LTI launch**: POST params → OIDC login flow with JWT id_token
- **Local Postgres**: stays in both versions

Fix: rename the abstraction. The 2 repository tokens (`CONFIG_REPOSITORY`,
`ASSESSMENT_REPOSITORY`) remain purely about swapping *where teacher config and
access-control data live* (local Postgres now, Canvas Deep Linking parameters later).
The outbox (`assessment_sessions`) is never swapped — it is always local.

The LTI 1.3 path:
- `LtiModule` adds OIDC login handlers (Phase G, already stubbed as 501)
- `CanvasService` adds `submitGradeAgs()` using JWT auth (Phase J)
- `SubmissionService` calls `submitGradeAgs()` instead of `submitGrade()` when
  `LTI_VERSION=1.3`; the outbox write in Step 1 is unchanged
- `Lti13ConfigRepository` stores teacher config via Deep Linking rather than
  `prompt_configs` table (swappable via `CONFIG_REPOSITORY` token)

This is the correct scope. `assessment_sessions` is never behind an abstraction token.

---

## Revised Architecture Summary

Changes from previous plan:

| Previous | Revised |
|----------|---------|
| 3 repository tokens | 2 tokens (`CONFIG_REPOSITORY`, `ASSESSMENT_REPOSITORY`) |
| `assignment_prompts` table | Removed — consolidated into `assessment_sessions` |
| `student_resets` table | Deferred |
| `ISessionRepository` interface | Removed |
| `SessionModule` | Removed |
| `assessment_sessions` has no score columns | Add `score`, `score_total` |
| No video upload protection | (see Gap B revision below) |
| `STORAGE_BACKEND=lti13` eliminates Postgres | `LTI_VERSION=1.3` changes Canvas auth only |
| `selectedCardsHtml` contains embed iframes | Contains titles only (no iframes) |
| React + no library guidance | Tailwind CSS + `react-player`, no component library |
| `assessment_sessions` is a permanent audit trail | **Transactional outbox — row deleted on full Canvas success** |
| Video → Cloudflare R2 → `video_url` stored | **Video → Canvas chunked upload; no intermediate cloud storage** |
| Separate `POST /api/submission/video` endpoint | **Video is multipart field in `POST /api/submission`** |
| Teacher retries failed syncs | **Student retries from browser MediaRecorder blob** |
| Teacher viewer reads HTML snapshots from DB | **Completed submissions in Canvas SpeedGrader; DB only holds failed/pending rows** |
| `video_url`, `video_sync_status` columns | **Removed; replaced with `canvas_file_id` checkpoint** |
| `VIDEO_STORAGE_URL`, `VIDEO_STORAGE_KEY` env vars | **Removed — no cloud storage needed** |

---

## Context

Grand Vision is migrating from a PHP/SQLite system deployed on shared hosting to a
modular NestJS application on Render with PostgreSQL. The two existing PHP tools —
ASLexpressFlashcards (flashcards.php, 809 lines) and ASLexpressPromptManager
(timer.php, viewer.php) — are being unified into a single cohesive platform where
flashcard decks serve as the question bank for timed recording assessments.

The immediate deliverable is a working NestJS flashcard API backed by SproutVideo
and Canvas, fronted by a React SPA. The secondary deliverable is the "bridge" between
deck selection and session configuration so assessments can be built on top of the
same deck data. PostgreSQL is the transactional outbox; the Canvas auth layer is
swappable for LTI 1.3 via `LTI_VERSION` without touching business logic.

No NestJS or React code exists yet. This is a greenfield build guided by the
behavioral contracts of the existing PHP.

---

## Monorepo Structure (Nx)

```
aslexpress/
  apps/
    api/                          ← NestJS application
      src/
        main.ts
        app.module.ts
        lti/
          lti.module.ts
          lti.controller.ts       ← two launch endpoints + /context + 1.3 stubs
          lti.service.ts
          guards/
            lti-launch.guard.ts
          dto/
            lti-launch.dto.ts
        flashcard/
          flashcard.module.ts
          flashcard.controller.ts
          flashcard.service.ts
          dto/
            session-result.dto.ts
          interfaces/
            playlist-item.interface.ts
        prompt/
          prompt.module.ts
          prompt.controller.ts
          prompt.service.ts
          dto/
            save-prompt.dto.ts
        assessment/
          assessment.module.ts
          assessment.controller.ts
          assessment.service.ts
          entities/
            assessment-session.entity.ts  ← Transactional outbox; deleted on Canvas success
            prompt-config.entity.ts
            blocked-attempt.entity.ts
          dto/
            save-config.dto.ts
            check-access.dto.ts
        submission/
          submission.module.ts
          submission.service.ts           ← outbox write → Canvas chunked upload → DELETE on success
          submission.controller.ts
          dto/
            submit-session.dto.ts
        sproutvideo/
          sproutvideo.module.ts
          sproutvideo.service.ts
          interfaces/
            sprout-playlist.interface.ts
            sprout-video-item.interface.ts
        canvas/
          canvas.module.ts
          canvas.service.ts
          dto/
            module-info.dto.ts
            grade-payload.dto.ts
        data/
          data.module.ts
          tokens.ts               ← 2 tokens: CONFIG_REPOSITORY, ASSESSMENT_REPOSITORY
          interfaces/
            config-repository.interface.ts
            assessment-repository.interface.ts
          repositories/
            postgres/
              pg-config.repository.ts
              pg-assessment.repository.ts
            lti13/
              lti13-config.repository.ts
              lti13-assessment.repository.ts
        common/
          guards/
            teacher-role.guard.ts
          decorators/
            lti-context.decorator.ts
          interfaces/
            lti-context.interface.ts
          filters/
            http-exception.filter.ts
    web/                          ← React SPA (Vite + Tailwind CSS)
      src/
        main.tsx
        AppRouter.tsx             ← reads /api/lti/context, routes to correct tool
        pages/
          FlashcardsPage.tsx
          TimerPage.tsx           ← includes RecoveryPanel; student grading lifecycle
          TeacherConfigPage.tsx
        components/
          flashcard/
            FlashcardViewer.tsx
            PlaylistMenu.tsx
            ScoreResults.tsx
          timer/
            WarmupTimer.tsx
            RecorderPanel.tsx     ← MediaRecorder + persists blob to IndexedDB for retry
            PromptDisplay.tsx     ← renders selectedCardsHtml (titles only)
            RecoveryPanel.tsx     ← student-facing; failed/pending outbox rows + Retry
            SnapshotViewer.tsx    ← dangerouslySetInnerHTML on outbox row HTML fields
          shared/
            VideoEmbed.tsx        ← SproutVideo iframe, student-facing only
        hooks/
          useLtiContext.ts
          useSproutVideo.ts
          useSubmission.ts        ← manages upload, IndexedDB blob, retry state
        api/
          flashcard.api.ts
          assessment.api.ts
          prompt.api.ts
          canvas.api.ts
          submission.api.ts
  libs/
    shared-types/
      src/
        lti-context.interface.ts
        playlist.interface.ts
        session-config.interface.ts
```

---

## Repository Abstraction (LTI 1.3 Swap)

### Two Tokens (Revised Down from Three)

`apps/api/src/data/tokens.ts`

```
CONFIG_REPOSITORY      ← prompt_configs: teacher config per resource link
ASSESSMENT_REPOSITORY  ← blocked_attempts: fingerprint access control
```

`assessment_sessions` is NOT behind a token. `SubmissionService` owns it directly
because the outbox is always local — it is not swapped in LTI 1.3.

### Interface Contracts

**`apps/api/src/data/interfaces/config-repository.interface.ts`**
```
IConfigRepository {
  getConfig(courseId, resourceLinkId): Promise<PromptConfig | null>
  findByResourceLinkTitle(resourceLinkTitle): Promise<PromptConfig | null>
  saveConfig(config: PromptConfig): Promise<void>
  deleteConfig(courseId, resourceLinkId): Promise<void>
}
PromptConfig { courseId, resourceLinkId, configJson, resourceLinkTitle?, canvasAssignmentId?, updatedAt }
```

**`apps/api/src/data/interfaces/assessment-repository.interface.ts`**
```
IAssessmentRepository {
  getBlockedAttempt(courseId, resourceLinkId, fingerprintHash): Promise<BlockedAttempt | null>
  recordAttempt(courseId, resourceLinkId, fingerprintHash): Promise<BlockedAttempt>
  clearAttempts(courseId, resourceLinkId): Promise<void>
  isBlocked(courseId, resourceLinkId, fingerprintHash, maxAttempts): Promise<boolean>
}
```

### Swap Mechanism

`apps/api/src/data/data.module.ts` reads `process.env.LTI_VERSION`:

```
LTI_VERSION=1.1  → PgConfigRepository, PgAssessmentRepository (default)
LTI_VERSION=1.3  → Lti13ConfigRepository (stores config via Deep Linking params),
                    PgAssessmentRepository (fingerprint blocking always stays local)
```

`LTI_VERSION` changes Canvas *auth mechanism*, not whether Postgres is used.
`assessment_sessions` outbox is always local in both modes.
In LTI 1.3, `CanvasService` gains `submitGradeAgs()` (JWT-signed AGS call);
`SubmissionService` calls that method instead of `submitGrade()`. No other
service changes.

### AssessmentService Constructor

```typescript
constructor(
  @Inject(CONFIG_REPOSITORY) private readonly configRepo: IConfigRepository,
  @Inject(ASSESSMENT_REPOSITORY) private readonly assessmentRepo: IAssessmentRepository,
)
```

---

## AssessmentSession Entity (Transactional Outbox)

`apps/api/src/assessment/entities/assessment-session.entity.ts`

`assessment_sessions` is a **transactional outbox**. Rows are created when the student
opens a session and **deleted** only after all Canvas steps complete successfully.
A row surviving in the DB means Canvas does not yet have the data.

Key changes from previous: removed `videoUrl`, `videoSyncStatus`, `syncedAt`,
`canvasSubmissionId`; added `canvasFileId`; `syncStatus` has no `'synced'` value
(success = deletion).

```typescript
@Entity('assessment_sessions')
export class AssessmentSessionEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() courseId: string;
  @Column() assignmentId: string;
  @Column() userId: string;
  @Column({ default: '' }) resourceLinkId: string;
  @Column('text', { nullable: true }) promptSnapshotHtml: string | null;
  @Column('text', { nullable: true }) selectedCardsHtml: string | null;
  @Column('simple-array') deckIds: string[];
  @Column({ default: 0 }) wordCount: number;
  @Column({ default: 0 }) score: number;
  @Column({ default: 0 }) scoreTotal: number;
  @Column({ nullable: true }) canvasFileId: string | null;
  @Column({ type: 'int', default: 0 }) uploadProgressOffset: number;
  @Column({
    type: 'text',
    enum: ['pending', 'uploading', 'failed'],
    default: 'pending',
  }) syncStatus: 'pending' | 'uploading' | 'failed';
  @Column({ nullable: true }) syncErrorMessage: string | null;
  @CreateDateColumn() startedAt: Date;
  @Column({ nullable: true }) submittedAt: Date | null;
}
```

### Outbox Workflow

**Flashcard grade submission (Phase C, no video):**
```
POST /api/submission  { score, scoreTotal, deckIds, wordCount }
  → INSERT INTO assessment_sessions ... ON CONFLICT (course_id, assignment_id, user_id)
      DO UPDATE SET score=:score, score_total=:total, submitted_at=NOW(), sync_status='pending'
  → CanvasService.submitGrade()  (LTI Outcomes API, or submitGradeAgs() in LTI 1.3)
  → on 200: DELETE FROM assessment_sessions WHERE id=:id
            return 201 Created
  → on failure: UPDATE SET sync_status='failed', sync_error_message=:err
                return 202 Accepted (work is safe; row remains for retry)
```

**Prompter recording submission (Phase E, with video):**
```
POST /api/submission  (multipart/form-data: metadata fields + video file)
  → INSERT INTO assessment_sessions (courseId, assignmentId, userId, score, scoreTotal,
      promptSnapshotHtml, selectedCardsHtml, deckIds, wordCount,
      submittedAt=NOW(), syncStatus='uploading', uploadProgressOffset=0)
      ON CONFLICT DO UPDATE (update all fields; preserve promptSnapshotHtml if not null;
      on retry, preserve uploadProgressOffset for resume)
  → CanvasService.initiateFileUpload(courseId, assignmentId, filename, size, contentType)
      → POST /api/v1/courses/:id/assignments/:id/submissions/self/files
      → returns { upload_url, upload_params }
  → CanvasService.uploadFileToCanvas(upload_url, upload_params, videoBuffer,
      { resumeFromOffset: row.upload_progress_offset })
      → CHUNKED upload: sends buffer in segments via Content-Range protocol
      → on chunk failure: throw with lastSuccessfulOffset; SubmissionService UPDATEs
        upload_progress_offset=lastSuccessfulOffset, sync_status='failed' → return 202
      → on success: returns { canvas_file_id } only after following final 3xx redirect
        to create_success and receiving confirmation (see Sentinel Buffer rule below)
  → UPDATE assessment_sessions SET canvas_file_id=:id  (checkpoint: file is on Canvas)
  → CanvasService.submitAssignmentWithFile(courseId, assignmentId, userId,
      canvas_file_id, bodyHtml=promptSnapshotHtml + selectedCardsHtml)
      → POST /api/v1/courses/:id/assignments/:id/submissions
        { submission_type: 'online_upload', file_ids: [canvas_file_id], body: bodyHtml }
  → CanvasService.submitGrade()  (LTI Outcomes API)
  → on full success: DELETE FROM assessment_sessions WHERE id=:id
                     return 201 Created
  → on failure at any step after INSERT:
      UPDATE SET sync_status='failed', sync_error_message=:err
      (and upload_progress_offset if chunk failed)
      return 202 Accepted (metadata + canvasFileId checkpoint preserved)

SENTINEL BUFFER RULE: The assessment_sessions row (Sentinel Buffer) MUST remain active
until the final "Confirm Success" redirect from Canvas is received. Specifically:
- uploadFileToCanvas() must NOT return a file_id until it has followed the 3xx redirect
  to create_success and received the 200/201 response. The upload is incomplete until
  that confirmation.
- The outbox row is deleted only after submitAssignmentWithFile + submitGrade succeed.
  No early deletion on partial success.
```

**Student retry (browser re-sends MediaRecorder blob):**
```
POST /api/submission/:id/retry  (optional multipart video file)
  → SELECT from assessment_sessions WHERE id=:id AND user_id=:ltiUserId
  → if canvasFileId IS NOT NULL:
      → file is already on Canvas — skip upload
      → retry only: submitAssignmentWithFile() + submitGrade()
  → if canvasFileId IS NULL and video file present:
      → resume upload: pass resumeFromOffset=row.upload_progress_offset to
        uploadFileToCanvas(); resumes from last successful byte offset on chunk failure
      → re-run full upload (with resume) + submit + grade sequence
  → if canvasFileId IS NULL and no video file:
      → return 400 Bad Request (video required)
  → on success: DELETE row → return 201
  → on failure: UPDATE sync_error_message, upload_progress_offset (if chunk failed) → return 202
```

`submittedAt IS NULL` → session open, never submitted (excluded from recovery panel)
`submittedAt IS NOT NULL AND syncStatus IN ('uploading','failed')` → needs Canvas sync
`canvasFileId IS NOT NULL AND syncStatus = 'failed'` → video on Canvas; retry is grade-only

---

## HTML Snapshot Strategy

`POST /api/prompt/session` fires when student opens the timer UI.
`PromptService.savePromptSnapshot()`:

1. Reads `config_json` for `(course_id, resource_link_id)`.
2. Fetches video items from selected `deckIds` via SproutVideoService.
3. Randomly draws `wordCount` items.
4. Renders `selectedCardsHtml` as **title-only HTML** (no SproutVideo embeds):
   `<div class="card"><h3>{title}</h3><p>{unit_code}</p></div>`
   Rationale: Canvas submission body must not contain iframes. Student `PromptDisplay`
   supplements each card with a live embed from `VideoEmbed` only during the warm-up.
5. Renders `promptSnapshotHtml` from Quill config.
6. Inserts into `assessment_sessions` ON CONFLICT DO NOTHING (query-builder level).

**Both HTML fields are submitted to Canvas** as the assignment submission body when
the student submits their recording. Canvas SpeedGrader becomes the permanent store;
the DB row is deleted on success. The combined HTML submitted to Canvas:
```html
<section class="prompt">{promptSnapshotHtml}</section>
<section class="cards">{selectedCardsHtml}</section>
```

**Recovery panel data** `GET /api/submission/failed` + `GET /api/submission/pending`
return the DB rows that still exist (Canvas sync not yet complete). This includes
`promptSnapshotHtml`, `selectedCardsHtml`, `syncStatus`, `canvasFileId`, and
`syncErrorMessage` so the student's recovery UI can show them what was attempted.

---

## Phase-by-Phase Build Plan

### Phase A — Foundation

- Scaffold Nx monorepo: `apps/api` (NestJS), `apps/web` (React + Vite + Tailwind CSS)
- Configure TypeORM with PostgreSQL + SSL (`DATABASE_URL`, `rejectUnauthorized: false`)
- Run schema migrations (revised schema below)
- Implement `DataModule` with **2** tokens and Postgres implementations
- Set up `ConfigModule` loading `.env`
- Implement `LtiModule`:
  - `POST /api/lti/launch/flashcards` → sets LtiContext in session → redirects `/flashcards`
  - `POST /api/lti/launch/prompter` → sets LtiContext in session; if Teacher, calls AssessmentService.syncAssignmentNameIfNeeded (resource_link_title), sets ctx.assignmentNameSynced → redirects `/prompter`
  - `GET /api/lti/context` → returns session-bound LtiContext (includes assignmentNameSynced, resourceLinkTitle)
- Implement `TeacherRoleGuard` (all 8 PHP role patterns)
- Build `AppRouter.tsx` with React Router, `useLtiContext()` hook, Tailwind CSS baseline
- Deliverable: App boots, two LTI endpoints route to correct tool, Tailwind renders

### Phase B — SproutVideo and Canvas Services

- `SproutVideoService`: `fetchAllPlaylists()` (paginated), `getSmartVersions()` (exact
  PHP regex port), `isBlacklisted()`, `filterPlaylists()`, `getPlaylistItems()`
- `CanvasService`:
  - `getModuleInfo()`, `buildFilterFromModuleName()` (PHP regex port)
  - `submitGrade()` — LTI 1.1 Outcomes API (XML POST to `lis_outcome_service_url`)
  - `initiateFileUpload(courseId, assignmentId, filename, size, contentType)` →
    `{ uploadUrl: string, uploadParams: Record<string, string> }`
    POST to `/api/v1/courses/:id/assignments/:id/submissions/self/files`
  - `uploadFileToCanvas(uploadUrl, uploadParams, buffer, options?: { resumeFromOffset?: number })` → `{ fileId: string }`
    **Chunked/Segmented upload** — MUST NOT send entire buffer in one POST. Use Canvas
    Content-Range protocol for multi-part uploads:
    - Send buffer in fixed-size chunks (e.g., 5MB) via `Content-Range: bytes {start}-{end}/{total}`
    - Each chunk POST returns `Range` or equivalent; track last successful byte offset
    - On chunk failure: throw with `lastSuccessfulOffset` so caller can persist and retry
    - Handle both S3 presigned and Canvas-local upload_url; adapt Content-Range semantics
      to destination (Canvas-local may use PUT+Content-Range; S3 uses multipart part numbers)
    - Final step: follow 3xx redirect to `create_success` endpoint — file not confirmed until
      this redirect is completed; do NOT consider upload complete until redirect returns 200
  - `submitAssignmentWithFile(courseId, assignmentId, userId, fileId, bodyHtml)` → void
    POST to `/api/v1/courses/:id/assignments/:id/submissions`
    `{ submission: { submission_type: 'online_upload', file_ids: [fileId], body: bodyHtml } }`
  - `renameAssignment(courseId, assignmentId, newName)` → void
    PUT to `/api/v1/courses/:id/assignments/:id` with `{ assignment: { name: newName } }`
- Deliverable: playlist filter output matches `sprout_bridge.php` exactly;
  Canvas file upload sequence can be exercised against a test Canvas instance

### Phase C — Flashcard Module + Outbox (Priority 1 Complete)

- `FlashcardController` + `FlashcardService`:
  - `GET /api/flashcard/playlists` → Canvas module filter → SproutVideo
  - `GET /api/flashcard/items`
- `SubmissionService` + `SubmissionController` (outbox write path):
  - `POST /api/submission` — UPSERT outbox row with score, attempt Canvas grade, DELETE on success
  - Returns 201 on sync or 202 if Canvas fails (work is safe)
- `calculateGrade()` in SubmissionService: tutorial = 0 pts, others = percentage
- Build `FlashcardsPage` (Tailwind): `PlaylistMenu`, `FlashcardViewer`, `ScoreResults`
  - Rehearsal / Tutorial / Screening modes, 85% benchmark, streak — all client-side
- Deliverable: End-to-end flashcard flow with outbox on every grade

---

### Pre-Phase D — Flashcard UX & Tutorial Mode To-Do

1. **Reset Deck & Pause**
   - Restore the missing "Reset Deck" button
   - Add a "Pause" button to tutorial mode

2. **Loading Spinner & Video Playback Enforcement**
   - **CSS Spinner & Data Fetching:**
     - In TeacherSettings.css, create a `.spinner` class with a smooth rotation animation
     - In TeacherSettings.tsx, display this spinner while loading is true; hide all configuration controls until the data fetch is complete
   - **SproutVideo IFrame Bridge (Tutorial Mode Fix):**
     - In the Flashcard Viewer, implement `window.addEventListener('message')` to capture the completed or ended signal from the SproutVideo player
     - Create a `canAdvance` state variable; initialize it to `false` whenever a new video starts
     - Enforcement: In "Tutorial Mode," the "Next" button must be disabled (use a `.disabled` CSS class) and auto-advance must be prevented until `canAdvance` is `true`

3. **Teacher Controls & Preview Mode**
   - Add a "View as Student" toggle; when active, hide teacher dropdowns and apply student-facing visibility rules
   - Add a "Require Full Playback" toggle to the settings
   - Labeling rule: Use ONLY "Show" and "Hide" for all toggles; remove any other text labels

4. **Clean Architecture**
   - Zero inline styles: move all spinner, layout, and disabled-state styling into the respective `.css` files
   - No comments in the code

---

### Phase D — Assessment Configuration (Bridge)

- `AssessmentService` + `AssessmentController`:
  - `GET/POST /api/assessment/config` (via CONFIG_REPOSITORY)
  - `POST /api/assessment/access`, `POST /api/assessment/attempt`, `DELETE /api/assessment/attempts`
  - `reconnectOrSync(courseId, assignmentId, resourceLinkId, resourceLinkTitle)` → `{ synced?: boolean, reconnected?: boolean }`
    Called during Teacher prompter launch. **Reconnection**: If no config for `(courseId, resourceLinkId)`, search by `resource_link_title`, find Canvas assignment named `${title} - Submission`, create new config row with current ids. **Auto-sync**: If config found and title mismatch, rename Canvas assignment, update prompt_configs. Returns flags for LtiContext notification.
- `SaveConfigDto`: `deckIds[]`, `wordCount`, `secondsPerCard`, `warmupEnabled`,
  `warmupListMode: 'exact' | 'random'`, `resourceLinkTitle?`
- Build `TeacherConfigPage` (Tailwind + Quill via CDN)
- Deliverable: teacher configures session per Canvas resource link

### Phase E — Outbox: Prompt Snapshot + Chunked Video Submission + Student Timer

- `PromptService.savePromptSnapshot()`: reads config, draws `wordCount` cards, renders
  title-only `selectedCardsHtml`, writes to `assessment_sessions` ON CONFLICT DO NOTHING
- `POST /api/prompt/session` — snapshot creation at session open (sets outbox row)
- `POST /api/submission` (multipart/form-data):
  - Receives video blob as file field alongside score/metadata fields
  - Step 1: UPSERT outbox row with score, metadata, `syncStatus='uploading'`,
    `uploadProgressOffset=0` (or preserve existing on retry for resume)
  - Step 2: `CanvasService.initiateFileUpload()` → Canvas returns `upload_url`
  - Step 3: `CanvasService.uploadFileToCanvas(upload_url, params, buffer, { resumeFromOffset })` —
    **Chunked upload**: sends buffer in segments via Content-Range protocol. On chunk failure,
    throws with `lastSuccessfulOffset`; SubmissionService UPDATEs `upload_progress_offset`,
    `sync_status='failed'`, `sync_error_message` → return 202. Student retry passes
    `resumeFromOffset=row.upload_progress_offset` to resume from last successful byte.
  - Step 4: Checkpoint — UPDATE `canvasFileId` in DB (only after final Confirm Success
    redirect; see Sentinel Buffer rule)
  - Step 5: `CanvasService.submitAssignmentWithFile()` — submission body = combined HTML
  - Step 6: `CanvasService.submitGrade()` via LTI Outcomes API
  - Step 7: DELETE outbox row → return 201; on any failure → return 202
- `POST /api/submission/:id/retry` (LtiLaunchGuard, student's own session):
  - If `canvasFileId IS NOT NULL`: skip upload, retry steps 5–7 only
  - If `canvasFileId IS NULL`: expects video blob in body; pass
    `resumeFromOffset=row.upload_progress_offset` to uploadFileToCanvas; retry steps 2–7
    with resume capability
- Build `TimerPage` (Tailwind + `react-player`): `WarmupTimer`, `PromptDisplay`
  (titles + live `VideoEmbed` during warm-up), `RecorderPanel` (MediaRecorder)
- `RecorderPanel` stores MediaRecorder blob in component state + IndexedDB on completion
  so retry survives a page refresh
- Deliverable: End-to-end recording submission; outbox row deleted on Canvas success

### Phase F — Student Recovery Panel

- `GET /api/submission/failed` (LtiLaunchGuard) — returns student's own failed rows
- `GET /api/submission/pending` (LtiLaunchGuard) — returns student's own uploading rows
- Build `RecoveryPanel` on `TimerPage`:
  - Shows failed/pending outbox rows with `syncErrorMessage` and `canvasFileId` status
  - If `canvasFileId IS NULL`: shows "Re-upload recording" button (reads blob from IndexedDB)
  - If `canvasFileId IS NOT NULL`: shows "Retry submission" button (no video needed)
  - On success response: removes row from panel
- `SnapshotViewer` — `dangerouslySetInnerHTML` on both HTML fields from outbox row
- Teachers grade completed submissions via Canvas SpeedGrader; our app has no
  custom viewer for rows that have already been deleted (Canvas is source of truth)
- Deliverable: Student can self-recover failed submissions without teacher intervention

### Phase G — LTI Hardening

- HMAC OAuth signature validation on LTI 1.1 launch guard
- Stub LTI 1.3 OIDC routes (`501 Not Implemented`)
- Deliverable: LTI hardened; 1.3 routes reserved

### Phase H — Caching

- Redis via `@nestjs/cache-manager`
- SproutVideo playlists: 10-min TTL; Canvas module info: 5-min TTL
- Deliverable: Production performance

### Phase J — LTI 1.3 Auth Swap (Future)

- Implement `Lti13ConfigRepository` (stores config via Deep Linking params)
- Add `CanvasService.submitGradeAgs()` (JWT-signed AGS call)
- `SubmissionService` calls `submitGradeAgs()` when `LTI_VERSION=1.3`
- Add OIDC login flow to `LtiController`
- Set `LTI_VERSION=1.3` in Render environment
- `assessment_sessions` outbox: unchanged — always local
- Zero changes to `AssessmentService`, `PromptService`, `FlashcardService`

---

## PostgreSQL Schema (3 tables, transactional outbox)

```sql
CREATE TABLE prompt_configs (
    course_id         TEXT        NOT NULL,
    resource_link_id  TEXT        NOT NULL,
    config_json       TEXT        NOT NULL,
    resource_link_title TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (course_id, resource_link_id)
);

CREATE TABLE blocked_attempts (
    course_id         TEXT        NOT NULL,
    resource_link_id  TEXT        NOT NULL DEFAULT '',
    fingerprint_hash  TEXT        NOT NULL,
    attempt_count     INTEGER     NOT NULL DEFAULT 0,
    blocked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (course_id, resource_link_id, fingerprint_hash)
);

CREATE TABLE assessment_sessions (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id             TEXT        NOT NULL,
    assignment_id         TEXT        NOT NULL,
    user_id               TEXT        NOT NULL,
    resource_link_id      TEXT        NOT NULL DEFAULT '',
    deck_ids              TEXT[]      NOT NULL DEFAULT '{}',
    word_count            INTEGER     NOT NULL DEFAULT 0,
    score                 INTEGER     NOT NULL DEFAULT 0,
    score_total           INTEGER     NOT NULL DEFAULT 0,
    prompt_snapshot_html  TEXT,
    selected_cards_html   TEXT,
    canvas_file_id        TEXT,
    upload_progress_offset INTEGER    NOT NULL DEFAULT 0,
    sync_status           TEXT        NOT NULL DEFAULT 'pending'
                                      CHECK (sync_status IN ('pending','uploading','failed')),
    sync_error_message    TEXT,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at          TIMESTAMPTZ,
    UNIQUE (course_id, assignment_id, user_id)
);

CREATE INDEX idx_blocked_course_link
    ON blocked_attempts(course_id, resource_link_id);

CREATE INDEX idx_sessions_failed
    ON assessment_sessions(course_id, user_id, sync_status)
    WHERE sync_status = 'failed';

CREATE INDEX idx_sessions_uploading
    ON assessment_sessions(course_id, user_id, sync_status)
    WHERE sync_status = 'uploading';
```

**Canvas upload refinement — Phase B & E:**
- `upload_progress_offset` — bytes successfully uploaded; enables resume from last chunk on
  retry. Reset to 0 on new submission; preserved across retries when `canvasFileId IS NULL`.

**Auto-healing name sync:**
- `resource_link_title` — stored assignment title in prompt_configs; compared to incoming `resource_link_title` on Teacher launch; updated when sync performed.

**Schema notes — what changed and why:**
- `assignment_prompts` removed — redundant with `assessment_sessions.prompt_snapshot_html`
- `student_resets` removed — PHP legacy; deferred
- `video_url`, `video_sync_status`, `synced_at`, `canvas_submission_id` removed — no cloud
  storage; outbox row deleted on success so 'synced' state is never stored
- `canvas_file_id` added — checkpoint: Canvas file upload completed but submission/grade
  may not yet be confirmed; enables retry to skip re-uploading the video
- `sync_status` values: `'pending'` (outbox row exists, not yet attempted),
  `'uploading'` (attempt in progress or was interrupted), `'failed'` (attempt failed)
  — there is no `'synced'` value because successful sync = row deleted
- `submitted_at IS NULL` = session open, student has not submitted (not in recovery panel)
- `submitted_at IS NOT NULL` = student attempted submission; row only survives on failure
- `config_json` stays `TEXT` — Quill HTML inside interacts poorly with JSONB
- All IDs are `TEXT` — Canvas returns numeric IDs inconsistently as strings

---

## All REST Endpoints

| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| POST | /api/lti/launch/flashcards | none | LTI 1.1 flashcard launch → session → redirect |
| POST | /api/lti/launch/prompter | none | LTI 1.1 prompter launch → session → redirect |
| GET | /api/lti/context | LtiLaunchGuard | Session-bound LtiContext for SPA bootstrap |
| GET | /api/lti/oidc/login | none | LTI 1.3 stub (501) |
| POST | /api/lti/oidc/redirect | none | LTI 1.3 stub (501) |
| GET | /api/flashcard/playlists | LtiLaunchGuard | Filtered SproutVideo playlists |
| GET | /api/flashcard/items | LtiLaunchGuard | Video items for a playlist |
| GET | /api/canvas/module | LtiLaunchGuard | Module info + filter string |
| GET | /api/assessment/config | TeacherRoleGuard | Get teacher config |
| POST | /api/assessment/config | TeacherRoleGuard | Save teacher config (UPSERT) |
| POST | /api/assessment/access | LtiLaunchGuard | Validate access code + fingerprint |
| POST | /api/assessment/attempt | LtiLaunchGuard | Record failed attempt |
| DELETE | /api/assessment/attempts | TeacherRoleGuard | Clear blocked attempts |
| POST | /api/prompt/session | LtiLaunchGuard | Write HTML snapshots to outbox row |
| POST | /api/submission | LtiLaunchGuard | Multipart: score + optional video; outbox → Canvas → DELETE on success |
| POST | /api/submission/:id/retry | LtiLaunchGuard | Student retry: video optional; smart-skips upload if canvasFileId set |
| GET | /api/submission/pending | LtiLaunchGuard | Student's own outbox rows with submittedAt IS NOT NULL |
| GET | /api/submission/failed | LtiLaunchGuard | Student's own failed outbox rows |

**Removed endpoints:**
- `POST /api/submission/video` — video is now a field in `POST /api/submission`
- `POST /api/submission/:id/retry-video` — merged into `POST /api/submission/:id/retry`
- `GET /api/prompt/viewer-data` — completed submissions live in Canvas; DB only holds failures
- `POST/DELETE /api/prompt/comment` — teachers use Canvas's native comment system in SpeedGrader

**Guard note:** `/api/submission/:id/retry` uses `LtiLaunchGuard` (student's own
session). The service enforces that `user_id` matches the LTI `userId` before any
Canvas call. A student cannot retry another student's row.

---

## Automatic Name Synchronization (Auto-Healing)

During a Teacher launch, if the incoming `resource_link_title` does not match the stored title in prompt_configs (AssessmentConfig), the system performs automatic sync.

### Logic Refinement: Auto-Reconnection via Naming

Handles "broken" links during course copies using name-matching.

#### 1. The Reconnection Trigger

If a launch occurs and no AssessmentConfig is found for the current `resource_link_id`:

- **Step A**: Search the database for an AssessmentConfig where `resource_link_title` matches the current launch title.
- **Step B**: If a match is found, query the Canvas API to find an assignment in the current course named `${resource_link_title} - Submission`.
- **Step C**: If both exist, update the database record: set the new `resource_link_id` and the new `canvas_assignment_id` to the current values. (Delete old row, insert new row with `(current_course_id, current_resource_link_id)` and config from matched row; store `canvas_assignment_id` in config.)

#### 2. Auto-Sync (Existing Links)

If a link is found but the name has changed:

- Automatically rename the Canvas assignment and update the DB record to match the new `resource_link_title`.
- Notify the teacher: "Tool renamed. Canvas assignment updated to match."

#### 3. Service Flow Summary

- **LtiService**: On launch, passes `courseId`, `assignmentId`, `resourceLinkId`, `resourceLinkTitle` to AssessmentService.
- **AssessmentService**:
  - **Reconnection path**: If no config for `(courseId, resourceLinkId)`, search CONFIG_REPOSITORY for config where `resource_link_title` = launch title. Call CanvasService to find assignment in course named `${resource_link_title} - Submission`. If both exist, delete old config row, insert new row with `(courseId, resourceLinkId)`, config data, `resource_link_title`, `canvas_assignment_id`. Set `ctx.linkReconnected = true`.
  - **Auto-sync path**: If config found and `resource_link_title` !== incoming, call `CanvasService.renameAssignment()`, update config. Set `ctx.assignmentNameSynced = true`.
- **CanvasService**:
  - `renameAssignment(courseId, assignmentId, newName)`: PUT assignment name.
  - `findAssignmentByName(courseId, assignmentName)`: GET assignments, filter by name; return assignment id or null.

### Detection & Sync (Existing Links)

1. **Detection**: On Teacher launch (prompter tool), LtiService passes `resource_link_title` to AssessmentService.
2. **Mismatch**: If `resource_link_title` !== stored `resource_link_title` in prompt_configs for `(course_id, resource_link_id)`.
3. **Canvas Update**: AssessmentService calls `CanvasService.renameAssignment(courseId, assignmentId, \`${newTitle} - Submission\`)` — PUT `/api/v1/courses/:id/assignments/:id` with `{ assignment: { name: newName } }`.
4. **DB Update**: AssessmentService updates `resource_link_title` in prompt_configs for that row (UPSERT or UPDATE).
5. **Notification**: LtiContext includes `assignmentNameSynced: boolean`. When `true`, frontend shows notification: "Tool renamed. Canvas assignment updated to match."

### LtiContext Addition

```typescript
assignmentNameSynced?: boolean;
resourceLinkTitle?: string;
linkReconnected?: boolean;
```

### Schema Addition

```sql
ALTER TABLE prompt_configs ADD COLUMN resource_link_title TEXT;
ALTER TABLE prompt_configs ADD COLUMN canvas_assignment_id TEXT;
```

### IConfigRepository Addition

- `findByResourceLinkTitle(resourceLinkTitle)`: Promise<PromptConfig | null> — search for config with matching title (global search; used when reconnecting after course copy).
- PromptConfig: add `canvasAssignmentId?: string | null`.

### Service Flow

- **LtiController** (prompter launch): If `isTeacherRole(roles)`, call `AssessmentService.reconnectOrSync(courseId, assignmentId, resourceLinkId, resourceLinkTitle)`. Set `ctx.assignmentNameSynced` and `ctx.linkReconnected` from result.
- **AssessmentService.reconnectOrSync**: First try getConfig. If null, run reconnection flow (search by title, find Canvas assignment, create new config row). If config found and title mismatch, run auto-sync flow (rename Canvas, update config). Return `{ synced?, reconnected? }`.
- **CanvasService.renameAssignment**: PUT Canvas assignment name to `${newTitle} - Submission`.
- **CanvasService.findAssignmentByName**: GET `/api/v1/courses/:id/assignments` (or search endpoint), filter by name, return assignment id.

### Verification

14. **Auto-healing name sync**: Teacher launches prompter with `resource_link_title` changed in Canvas. Stored config has old title. Confirm: Canvas assignment renamed to `${newTitle} - Submission`; prompt_configs.resource_link_title updated; GET /api/lti/context returns `assignmentNameSynced: true`; frontend shows "Tool renamed. Canvas assignment updated to match."
15. **Auto-reconnection on course copy**: Teacher copies course. Launches prompter from copied course. No config exists for new resource_link_id. Config exists (from original course) with matching resource_link_title. Canvas has assignment named `${title} - Submission` in new course. Confirm: New config row created with (current_course_id, current_resource_link_id); `linkReconnected: true` in LtiContext; frontend shows reconnection notification.

---

## Canvas Upload Refinement (Phase B & E)

| Requirement | Implementation |
|-------------|----------------|
| **Chunked uploads** | `uploadFileToCanvas()` MUST NOT send entire buffer in one POST. Use Content-Range protocol: send buffer in fixed chunks (e.g., 5MB), `Content-Range: bytes {start}-{end}/{total}`. |
| **Resume on chunk failure** | On chunk failure, `CanvasService` throws with `lastSuccessfulOffset`. `SubmissionService` UPDATEs `upload_progress_offset`, `sync_status='failed'`. Retry passes `resumeFromOffset` to resume from that byte. |
| **Sentinel Buffer lifecycle** | Outbox row remains until final Canvas "Confirm Success" redirect. `uploadFileToCanvas()` must follow 3xx to `create_success` and receive 200/201 before returning `fileId`. No early deletion. |
| **Retry behavior** | `POST /api/submission/:id/retry` with video: pass `resumeFromOffset=row.upload_progress_offset`. If `canvasFileId` already set, skip upload entirely. |

---

## Critical Files

| File | Why Critical |
|------|-------------|
| `apps/api/src/data/tokens.ts` | 2 tokens; every abstracted dependency flows through here |
| `apps/api/src/data/data.module.ts` | `LTI_VERSION` toggle; `useClass` binding for Canvas auth swap |
| `apps/api/src/submission/submission.service.ts` | Outbox write → Canvas upload → Canvas submit → DELETE; a bug here loses student work |
| `apps/api/src/assessment/entities/assessment-session.entity.ts` | Outbox entity; `canvasFileId` checkpoint enables smart retry; ON CONFLICT at query-builder level |
| `apps/api/src/canvas/canvas.service.ts` | `initiateFileUpload()`, `uploadFileToCanvas()` (chunked Content-Range + resume), `submitAssignmentWithFile()` |
| `apps/api/src/sproutvideo/sproutvideo.service.ts` | `getSmartVersions()` must exactly replicate PHP regex |
| `apps/api/src/prompt/prompt.service.ts` | Renders title-only `selectedCardsHtml`; must NOT include iframe embeds |
| `apps/api/src/lti/lti.controller.ts` | Sets `toolType` in session; wrong value routes student to wrong tool |
| `apps/api/src/lti/lti.service.ts` | `isTeacherRole()` must match all 8 PHP patterns; `extractContext()` includes `resourceLinkTitle` |
| `apps/api/src/assessment/assessment.service.ts` | `reconnectOrSync()` — reconnection (course copy) + auto-sync (name change) on Teacher launch |
| `apps/api/src/canvas/canvas.service.ts` | `renameAssignment()`, `findAssignmentByName()` — PUT assignment name; search by name |
| `apps/web/src/AppRouter.tsx` | Entry point; reads `toolType` from LtiContext, mounts correct page |
| `apps/web/src/components/timer/RecorderPanel.tsx` | Persists MediaRecorder blob to IndexedDB on completion for retry durability |

---

## Render Deployment Requirements

### Port and Host Binding
```typescript
await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
```

### Build Script (`render-build.sh`)
```bash
npm ci
nx build api --prod
nx build web --prod
npx typeorm migration:run -d apps/api/dist/data-source.js
```
- **Build Command**: `bash render-build.sh`
- **Start Command**: `node apps/api/dist/main.js`

### Environment Variables
```
DATABASE_URL       ← Render Managed PostgreSQL (sslmode=require)
SPROUT_KEY         ← SproutVideo API key
CANVAS_API_TOKEN   ← Canvas Bearer token (LTI 1.1); RSA private key in LTI 1.3
CANVAS_DOMAIN      ← e.g. tjc.instructure.com
CURRICULUM_PREFIX  ← e.g. TWA
LTI_VERSION        ← 1.1 (default) | 1.3
SESSION_SECRET     ← Server-side session signing key
PORT               ← injected by Render automatically
NODE_ENV           ← production
```

`VIDEO_STORAGE_URL` and `VIDEO_STORAGE_KEY` are removed — no intermediate cloud storage.
Videos go directly from API server memory to Canvas's upload endpoint.

### PostgreSQL SSL
```typescript
TypeOrmModule.forRootAsync({
  useFactory: (config: ConfigService) => ({
    type: 'postgres',
    url: config.get('DATABASE_URL'),
    ssl: config.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
    entities: [__dirname + '/**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    migrationsRun: false,
  }),
})
```

### Static File Serving
```typescript
ServeStaticModule.forRoot({
  rootPath: join(__dirname, '..', '..', 'web', 'dist'),
  exclude: ['/api/(.*)'],
})
```
All API routes prefixed `/api` via `app.setGlobalPrefix('api')`.

---

## Code Constraints (carry through all implementation)

- No comments in any code
- Full files only — no fragments, no "// rest of code here" placeholders
- Exact filename specified for every code block
- No backwards-compatibility shims for unused code

---

## Verification

1. **LTI routing**: POST to `/api/lti/launch/flashcards` → browser on `FlashcardsPage`.
   POST to `/api/lti/launch/prompter` → browser on `TimerPage`.
2. **Outbox — flashcard happy path**: Submit flashcard session. After `POST /api/submission`
   returns 201, confirm `assessment_sessions` has **no row** for that
   `(course_id, assignment_id, user_id)`. Canvas grade is posted.
3. **Outbox — Canvas grade failure**: Mock Canvas Outcomes API → 500. Submit flashcard.
   Row persists with `sync_status='failed'`. Student gets `202 Accepted`.
4. **Outbox — prompter happy path**: Submit session with video blob. Confirm:
   - Row created with `sync_status='uploading'` during upload
   - `canvas_file_id` populated in DB after upload step
   - Row deleted after Canvas assignment submission + grade confirm
   - Canvas submission body contains both HTML sections
5. **Outbox — upload failure (no file_id)**: Simulate Canvas upload_url POST → timeout.
   Row has `sync_status='failed'`, `canvas_file_id IS NULL`. Student retry requires video.
5a. **Outbox — chunk failure (resumable)**: Simulate chunk 2 of 4 fails. Row has
   `sync_status='failed'`, `canvas_file_id IS NULL`, `upload_progress_offset` = bytes
   of chunk 1. Student retry with video blob resumes from that offset; only chunks 2–4
   sent. Full upload completes without re-sending chunk 1.
6. **Outbox — upload ok, submission failure**: Simulate `submitAssignmentWithFile` → 500.
   Row has `sync_status='failed'`, `canvas_file_id IS NOT NULL`. Retry skips re-upload.
7. **Student-only retry authorization**: Call `POST /api/submission/:id/retry` with a
   different student's LTI session → 403. Cannot retry another student's row.
8. **Snapshot immutability**: Open student session. Teacher edits config. HTML snapshot
   fields in the outbox row are unchanged (ON CONFLICT DO NOTHING preserved them).
9. **No iframes in Canvas submission**: Confirm `selected_cards_html` submitted to Canvas
   contains `<h3>` tags but no `<iframe>` tags.
10. **SproutVideo matching**: `GET /api/flashcard/playlists?filter=TWA.05.01` output
    matches `sprout_bridge.php?filter=TWA.05.01` exactly.
11. **LTI_VERSION swap**: Set `LTI_VERSION=1.3`, restart API, call `/api/assessment/config` —
    confirm `Lti13ConfigRepository` is active; call `/api/submission` — confirm
    `SubmissionService` still writes to `assessment_sessions` outbox (unchanged).
12. **LTI role guard**: `POST /api/assessment/config` as student → 403.
13. **Recovery panel**: Seed one `failed` row (no `canvas_file_id`) and one `failed` row
    (with `canvas_file_id`). Load recovery panel — confirm first shows "Re-upload recording"
    and second shows "Retry submission" with no video field required.
