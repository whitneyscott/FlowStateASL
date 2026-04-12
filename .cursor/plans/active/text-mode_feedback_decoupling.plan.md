---
name: Text-mode feedback decoupling
overview: In text-prompt grading mode, keep and implement Canvas LMS per-criterion rubric comments (below ratings, on rubric_assessment). Remove only the incorrect client hack that assigns timestamped video comments to rubric rows. Put timestamped comments in a separate list beside the rubric. Deck mode unchanged.
todos:
  - id: remove-timestamped-to-criterion-hack
    content: Remove feedbackCriterionById, activeTextCriterionIndex, feedbackByTextRubricRow—only used to bucket timestamped comments into rubric rows (not Canvas rubric comments)
    status: completed
  - id: canvas-rubric-parity
    content: Add/complete Canvas-style per-criterion rubric comments—UI under each rating + rubric_assessment comments round-trip with merge
    status: completed
  - id: text-left-split-jsx
    content: Text-mode left sidebar—full rubric column (criterion + ratings + per-criterion comment) beside separate timestamped feedback table
    status: completed
  - id: css-text-split
    content: Add PrompterPage.css grid/split + rubric comment-under-rating styling
    status: completed
  - id: verify-build
    content: Run web:build; verify in Canvas SpeedGrader rubric ratings + per-criterion comments; verify timestamped list separate
    status: completed
isProject: true
---

**Canonical location (repo):** `[.cursor/plans/active/text-mode_feedback_decoupling.plan.md](text-mode_feedback_decoupling.plan.md)` (Windows: `FlowStateASL\.cursor\plans\active\`). Cursor’s Create Plan tool may also create a copy under your user profile; treat **this file** in the repo as the one to commit and open.

# Text-mode rubric vs timestamped feedback

## Scope clarification (read this first)

**Per-criterion rubric feedback is not removed.** It is **required** and should match Canvas.


| Channel                          | What it is                                                                                                                                                       | Stays?                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Per-criterion rubric comment** | Text tied to **one rubric row**, shown **below that row’s ratings**, saved on Canvas `**rubric_assessment[criterionId].comments`** (with `rating_id` / `points`) | **Yes — keep and implement / round-trip** (today the app mainly saves ratings only; comments need UI + payload merge). |
| **Timestamped video comment**    | Text tied to **playback time**, saved as **submission comments** with `[m:ss]` prefix                                                                            | **Yes — keep** in a **separate** list; **must not** be assigned to a criterion index.                                  |


**What gets removed:** Only the **wrong implementation**: `feedbackCriterionById`, `activeTextCriterionIndex`, and rendering timestamped `FeedbackEntry` rows **inside** the rubric table as if they were criterion feedback. That hack **is not** Canvas rubric behavior.

**Net result for teachers:** Same two concepts as in SpeedGrader: **rubric row** (rating + optional criterion comment) **and** (in our tool) an extra **timestamped feedback** column for video-specific notes.

---

## Problem

In [apps/web/src/pages/TeacherViewerPage.tsx](apps/web/src/pages/TeacherViewerPage.tsx), **text prompt mode** currently:

- Misuses **timestamped** `FeedbackEntry` items by storing `feedbackCriterionById` / `activeTextCriterionIndex` and **showing those timestamped comments inside the rubric grid**.
- Does **not** yet offer a proper **Canvas per-criterion rubric comment** field under each rating, nor round-trip `comments` on `rubric_assessment`.

So the bug is **conflation**, not “too much criterion feedback”: timestamped comments were treated like criterion comments, while **real** criterion comments (Canvas) were not fully modeled.

---

## Canvas LMS parity (per-criterion rubric)

Implementation should **model SpeedGrader’s rubric panel**, not invent a parallel rubric model:

- **Per criterion (one rubric row):**
  - Show the **criterion description** and **points** in line with how teachers read rubrics in Canvas (description + max points for that row).
  - Show **rating options** as the selectable levels for that criterion (equivalent to clicking a cell in Canvas’s rubric grid / rating list).
  - Place the **criterion comment** control **immediately below** the rating controls for **that** criterion only—same information hierarchy as Canvas (comment explains the chosen level for that row).
- **Persistence:** Use the same mechanism Canvas uses for graded rubrics on a submission: `PUT` submission with `rubric_assessment` whose **keys are criterion ids** (already how [handleRubricRatingClick](apps/web/src/pages/TeacherViewerPage.tsx) builds the map) and whose **values** include at least `rating_id` and `points`, plus `**comments`** (string) when the teacher enters criterion feedback. On load, hydrate comment text from `current.rubricAssessment[criterionId]` (Canvas returns criterion-scoped objects; parse `comments` when present).
- **Merge strategy:** Every save that touches one criterion must **merge** full existing assessment from the server-backed `current.rubricAssessment` + in-flight local state so other criteria’ ratings and comments are not dropped (mirror Canvas saving the whole rubric assessment).
- **Reference:** Validate request/response field names against [Canvas Submissions API](https://canvas.instructure.com/doc/api/submissions.html) (`rubric_assessment` on submission update) during implementation; adjust only if Canvas uses alternate keys for criterion-level `comments`.

**Explicitly not Canvas rubric behavior:** Mapping **timestamped** submission comments into rubric rows—that stays in the **separate** timestamped list.

---

## Target behavior (text prompt mode)

### A. Rubric column (Canvas-like) — criterion-based feedback stays here

- Each criterion: description → ratings → **criterion comment** (Canvas) directly under that row’s ratings.
- Save path: `submitGrade` / `putSubmissionGrade` with merged `rubric_assessment` including `**comments` per criterion**.

### B. Timestamped free-form feedback (separate column)

- Beside the rubric: **“Timestamped feedback”** table — one row per `[m:ss]` comment; seek / edit / delete; **no** `criterionId`.
- APIs: existing `addComment`, `editComment`, `deleteComment`.

### Deck prompt mode

- Unchanged: 4-column deck rubric + time-window feedback rows as today.

---

## Implementation steps

1. **Remove only the timestamped→criterion hack** in `TeacherViewerPage.tsx`:
  - Delete `activeTextCriterionIndex`, `feedbackCriterionById`, related `useEffect`, and `feedbackByTextRubricRow`.
  - Simplify `syncFeedbackFromCurrent` to only drive `feedbackEntries` from `parseTimestampedFeedback` (no criterion map for timestamped comments).
  - Clean `handleAddComment` / `handleDeleteComment` (no criterion id on new timestamped comments).
2. **Add / complete Canvas-aligned per-criterion rubric comments** (text mode rubric column; deck layout unchanged):
  - Hydrate per-criterion **comments** from `current.rubricAssessment` alongside existing rating sync.
  - Under each criterion’s ratings: comment field + save that merges `**comments`** into `rubric_assessment` with existing `rating_id` / `points`.
  - Rating clicks preserve **comments** for that criterion; comment saves preserve **rating_id** / **points**.
3. **Text-mode left layout**:
  - `div.prompter-viewer-text-left-split`:
    - **Child 1 — Rubric:** full Canvas-style rubric (criterion + ratings + **per-criterion comment** under ratings).
    - **Child 2 — Timestamped:** table of `feedbackEntries` only.
4. **CSS** in [apps/web/src/pages/PrompterPage.css](apps/web/src/pages/PrompterPage.css):
  - Grid split; rubric column styling so criterion comments visually belong to **that** rubric row (Canvas-like).
5. **Verify**: `npm exec nx run web:build`; in **Canvas SpeedGrader**, confirm rubric + **per-criterion comments** match; confirm timestamped list is separate and seeks video.

---

## Files touched (expected)

- [apps/web/src/pages/TeacherViewerPage.tsx](apps/web/src/pages/TeacherViewerPage.tsx) — remove timestamped/criterion hack; add Canvas criterion comments + merged `rubricAssessment`.
- [apps/web/src/pages/PrompterPage.css](apps/web/src/pages/PrompterPage.css) — split layout + rubric comment placement.
- Possibly [apps/web/src/api/prompt.api.ts](apps/web/src/api/prompt.api.ts) or DTO types if `rubricAssessment` typing is too narrow.

---

## Out of scope

- Changing deck-mode time-window feedback layout.
- Video loading, refs, or media-related code.

