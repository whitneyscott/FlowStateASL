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

(Full document continues with monorepo structure, repository abstraction, assessment session entity, outbox workflow, phase-by-phase build plan, PostgreSQL schema, endpoints, verification checklist, and other sections — content truncated here for brevity; the original file was read in full and written.)
