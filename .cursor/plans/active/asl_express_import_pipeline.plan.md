---
name: ASL Express import pipeline
overview: Three separate teacher-facing pipelines (orphan restore, cross-course import, TRUE+WAY course setup) sharing name resolution and dual-write blob helpers; distinct UI entry points on Teacher Config.
todos:
  - id: shared-resolve-by-name
    content: Implement resolveAssignmentIdByName(name, targetCourseAssignments) → matched | conflict | unmatched; unit tests
  - id: shared-write-blobs
    content: Factor writePromptManagerSettingsBlob + writeFlashcardSettingsBlob (assignment + announcement sync) from existing putConfig / course-settings paths
  - id: pipeline1-orphan-restore
    content: Pipeline 1 — same-course orphan restore for Prompt Manager + Flashcards (read old blob, validate, merge, write, stale-key warnings)
  - id: pipeline2-cross-course
    content: Pipeline 2 — cross-course import with remap UI for conflicts/unmatched; drop resourceLink map; clear module/group/rubric; deck remap by title where applicable
  - id: pipeline3-twa-detect
    content: Pipeline 3 — TWA assignment + module detection via agreed regexes; HTML parsers for SOAR and Watch and Sign descriptions
  - id: pipeline3-twa-modules
    content: Pipeline 3 — Canvas module/Page/LTI insertions with idempotency + destructive description-clear confirmation modal
  - id: prompt-mode-watch-sign
    content: Add promptMode watch_and_sign + Timer/recorder student flow (Watch then single narrative Record); align PromptConfigJson / DTOs with SOAR fields (warmup, sprout refs, etc.)
  - id: production-question-banks
    content: Production Test — Claude generation, approval modals, random variation at test start; confirm or add persistence schema
  - id: ui-three-entry-points
    content: TeacherConfigPage — three separate flows (Restore / Import course / Set up TRUE+WAY) with appropriate confirmations
---

# ASL Express import pipeline — full plan

Canonical copy in repo: [`.cursor/plans/active/asl_express_import_pipeline.plan.md`](asl_express_import_pipeline.plan.md).

## Overview

Three distinct pipelines sharing common infrastructure (name resolution, blob write helpers). They are **separate entry points in the UI** — do not collapse them into one generic “import” flow.

---

## Pipeline 1 — Orphan restore (same course)

### Problem

Teacher deleted and reinstalled the LTI tool in the **same** course. The new install created a fresh empty **Prompt Manager Settings** assignment and announcement. The old settings blob — with fully valid assignment IDs — is stranded in the **old** assignment/announcement. **No ID remapping** needed; assignments never moved.

### Transform

Trivial: validate schema → write to the **new** settings location.

### Steps

1. Read old blob from old **Prompt Manager Settings** assignment description or **ASL Express Prompt Manager Settings** announcement (reuse [`readPromptManagerSettingsBlob`](apps/api/src/prompt/prompt.service.ts) against the **orphan** topic/assignment the teacher identifies, or discover duplicates by title).
2. Validate against existing DTO / blob shape; reject unknown `v` or malformed `configs`.
3. If the **new** settings blob already has partial content — **merge**, preserving any keys **not** present in the old blob (or not in the import payload for that key).
4. Write merged blob to new settings assignment + announcement via **`writePromptManagerSettingsBlob`** (factored from existing `putConfig` dual-write in [`prompt.service.ts`](apps/api/src/prompt/prompt.service.ts)).
5. After write: **stale key warning** — flag any `configs` keys whose assignment ID no longer exists in the course.

### Same pattern — Flashcard orphan restore

Same dual-write target: **Flashcard Settings** assignment + **ASL Express Flashcard Settings** announcement ([`course-settings.service.ts`](apps/api/src/course-settings/course-settings.service.ts) + [`canvas.service.ts`](apps/api/src/canvas/canvas.service.ts) announcement helpers).

---

## Pipeline 2 — Cross-course import

### Problem

Teacher copies settings from another course (e.g. prior semester). Canvas course copy preserves assignment **names** but issues new assignment **IDs**. Old IDs are invalid in the target course.

### Name resolution utility (shared with Pipeline 3)

Single implementation:

```ts
resolveAssignmentIdByName(
  name: string,
  targetCourseAssignments: Assignment[],
): ResolveResult;
```

Returns:

- `{ status: 'matched', newId }` — exactly one match
- `{ status: 'conflict', candidates: Assignment[] }` — multiple assignments share the same name
- `{ status: 'unmatched' }` — no match

### Steps

1. Teacher provides **source `course_id`** (same Canvas domain).
2. Read source blob via `readPromptManagerSettingsBlob` using the **`getEffectiveCanvasToken`** pattern ([`course-settings.service.ts`](apps/api/src/course-settings/course-settings.service.ts)).
3. Fetch assignment list for **source** and **target** courses (existing Canvas list patterns).
4. For each `oldAssignmentId` key in source blob:
   - Resolve assignment **name** from source course list.
   - Run `resolveAssignmentIdByName` against target course list.
   - `matched` → remap automatically.
   - `conflict` → add to conflict list for teacher resolution.
   - `unmatched` → unmatched list; teacher skips or manual map.
5. UI presents conflict/unmatched items — teacher resolves **before** import proceeds.
6. **`resourceLinkAssignmentMap`** — **drop on import**; rebuilt on next LTI launch.
7. Canvas-specific fields (`moduleId`, `assignmentGroupId`, `rubricId`) — **clear on import**; teacher re-resolves post-import.
8. Fields **safe to copy as-is** (where present): YouTube `videoId`, text `prompts`, timing values, Sprout video identifiers in prompt content (subject to deck-ID remapping policy below).
9. Write remapped blob using **`merge`** or **`replace_selected`** to target settings assignment + announcement.

### Import modes

- **`merge`** — preserves keys in target not listed in / touched by import.
- **`replace_selected`** — overwrites only listed assignment IDs **after** remap.

### Same pattern — Flashcard cross-course

Read source flashcard settings JSON; **remap deck IDs by title match** where possible; write via **`writeFlashcardSettingsBlob`** and existing dual-write behavior.

---

## Pipeline 3 — TRUE+WAY ASL course setup

### Overview

**Not** a settings migration. TWA assignments already exist from the publisher cartridge. Pipeline 3 **detects** them by name, scaffolds module structure, creates Canvas Pages, inserts LTI items, generates Production Test question banks, and writes Prompt Manager configs. This is a **course scaffolding** operation.

### Detection patterns

**Assignment title regexes:**

| Type           | Pattern                                              |
| -------------- | ---------------------------------------------------- |
| SOAR           | `/^Unit (\d+) SOAR$/i`                               |
| Watch and Sign | `/^Unit (\d+)(\.\d+)? Watch and Sign$/i`            |
| Production     | `/^Unit (\d+)(\.\d+)? Production$/i`                |

**Module name regexes:**

| Type        | Pattern                    |
| ----------- | -------------------------- |
| Unit intro  | `/^⭐ Unit (\d+): .+/`      |
| Section     | `/^⭐ Unit (\d+\.\d+) .+/` |
| Unit review | `/^⭐ Unit (\d+) Review$/`  |

Unit number extracted from each pattern provides cross-reference between assignments and modules.

### HTML parsing — SOAR assignment

From assignment description HTML:

| Field             | Source                         | Method                                      |
| ----------------- | ------------------------------ | ------------------------------------------- |
| Unit number       | `<h2>` title                   | `/Unit (\d+)/`                              |
| Sprout video ID   | iframe `src`                   | `/embed\/([a-f0-9]+)\/([a-f0-9]+)/` (cap 1) |
| Sprout video hash | iframe `src`                   | second capture group                        |
| Sentences (1–10)  | `<ol><li>` items               | strip HTML → plain text                     |
| Boilerplate       | description + copyright footer | fingerprint to confirm assignment type    |

### HTML parsing — Watch and Sign assignment

| Field              | Source                         | Method                   |
| ------------------ | ------------------------------ | ------------------------ |
| Unit number        | `<h2>` title                   | `/Unit (\d+)/`          |
| Sprout ID + hash   | iframe `src`                   | same regex as SOAR       |
| Objective text     | first `<p>` after Objective  | strip HTML               |
| Instructions text  | `<p>` after Instructions       | strip HTML               |
| Suggested signs    | `<ul><li>` items               | strip HTML               |

### Module transformations per unit

#### Unit intro module — `⭐ Unit X: [Topic]`

| Action | Item                                                         | Position                               |
| ------ | ------------------------------------------------------------ | -------------------------------------- |
| INSERT | Canvas Page — SOAR reference (Sprout + 10 sentences)         | Teacher-configurable; default = end of module |

#### Unit review module — `⭐ Unit X Review`

| Action | Item                                                         | Position                                      |
| ------ | ------------------------------------------------------------ | --------------------------------------------- |
| INSERT | Canvas Page — Watch and Sign reference (objective + instructions + signs + Sprout) | Top of module                                 |
| INSERT | LTI — Watch and Sign                                         | Immediately **above** TWA Watch and Sign assignment |
| MODIFY | TWA Watch and Sign assignment                                | Clear description → redirect message          |
| INSERT | LTI — SOAR                                                   | Immediately **above** TWA SOAR assignment      |
| MODIFY | TWA SOAR assignment                                          | Clear description → redirect message          |

**Destructive warning:** Clearing TWA assignment descriptions is **irreversible**. Teacher must confirm in an **approval modal** before Pipeline 3 runs any modification.

**Idempotency:** Before inserting a module item, check whether an LTI item of the same type already exists **adjacent** to the target assignment; **skip** if present so re-run does not duplicate.

### Prompt Manager config written per assignment

#### SOAR config (conceptual)

- Text-style prompts: 10 sentences verbatim.
- Warm-up: `warmupEnabled` (teacher toggle), `warmupDurationMinutes` (default 5, teacher-configurable).
- Sprout reference: `sproutVideoId`, `sproutVideoHash` for display during watch/practice; **not** the prompt driver — students read each sentence and record signing it.
- `submissionAssignmentId`: TWA SOAR Canvas assignment id.

**Codebase alignment (implementation):** Today [`PromptConfigJson`](apps/api/src/prompt/dto/prompt-config.dto.ts) uses `promptMode` (`'text' | 'decks' | 'youtube'`), not `mode`. SOAR-specific fields (`warmupEnabled`, `sproutVideoId`, `submissionAssignmentId`, etc.) will need DTO + API + UI extensions unless mapped onto existing fields.

#### Watch and Sign config (conceptual)

- New **`promptMode`: `watch_and_sign`** (or equivalent) — see below.
- Sprout reference ids/hashes; `recordingTimeLimitMinutes` (default 3, teacher-configurable).
- `submissionAssignmentId`: TWA Watch and Sign assignment id.

### New prompt mode: Watch and Sign

Hybrid: neither pure static text nor YouTube stimulus mode.

**Student flow:**

1. **Watch** — Sprout video; student may rewatch freely.
2. **Record** — single continuous narrative take, time-limited (default 3 min).

**Inherited:** recording time limit patterns from static/text flow; stimulus-as-video from video/Sprout patterns. **Different:** video is not a model to imitate; response is **one continuous narrative**, not discrete per-sentence prompts.

**In-class vs homework:** Either; default homework using existing recorder. Structured in-class (Watch → Plan → Record) **deferred** pending cohort feedback; architecture should allow a future flag.

### Production Test — question bank generation

**Generation**

- **Input:** 10 SOAR sentences (grammar pattern) + unit flashcard deck vocabulary + all **prior** unit deck vocabulary.
- **Output:** Minimum **10 variation sets × 5 sentences** each (≥ 50 sentences).
- **Constraints:** Same grammatical structures as SOAR sources; vocabulary appropriate to unit + prior units; synonyms acceptable; comparable difficulty across sets; **no duplicate sentences** across sets.
- **Method:** Claude API with strict system prompt.

**At test time**

- Random variation set per student at test start; simultaneous start to limit peer preview.

**Storage**

- Plan assumes **existing** question-bank storage schema. **Verify during implementation:** repo may not yet expose a “question bank” entity under that name — add or wire explicitly before claiming “no new design.”

**Teacher approval (mandatory)**

- **Start:** Modal — e.g. generating for Unit X using vocab from Units 1–X; synonyms allowed; teacher knows students best.
- **End:** Full display of all variation sets; approve publish or regenerate per set; **cannot** be accidentally dismissed (non-dismissible or explicit destructive close only).

---

## Shared infrastructure

| Piece                         | Role                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `resolveAssignmentIdByName`   | Pipeline 2 remap + Pipeline 3 linking                              |
| `writePromptManagerSettingsBlob` | All pipelines that persist PM blob + announcement               |
| `writeFlashcardSettingsBlob`  | Flashcard orphan + cross-course                                     |

Implement **`writePromptManagerSettingsBlob`** by factoring logic from [`putConfig`](apps/api/src/prompt/prompt.service.ts) (assignment description + [`findSettingsAnnouncementByTitle` / create / update](apps/api/src/canvas/canvas.service.ts)).

---

## UI entry points ([`TeacherConfigPage.tsx`](apps/web/src/pages/TeacherConfigPage.tsx))

**Three distinct flows** — do not merge into one wizard:

1. **Restore orphaned settings** — “I reinstalled the LTI and lost my settings.”
2. **Import from another course** — “Copy settings from a previous semester.”
3. **Set up TRUE+WAY ASL** — “Cartridge imported; configure ASL Express for it.”

Each flow gets its own confirmation / risk UX (Pipeline 3 highest friction for destructive steps).

---

## Security and operations

- Endpoints: **teacher** context + valid Canvas token only.
- Cross-course: verify token can read **source** course before returning blob.
- Destructive ops (clear TWA descriptions): **explicit** confirmation.
- `appendLtiLog`: course IDs, counts, remap stats — **do not** log full prompt bodies.
- Rate-limit or confirm destructive **`replace_selected`**.
- After any import: **stale config key** detection for `configs` keys with no matching assignment in course.

---

## Deferred

- **Timed flashcard-style production prompts** — architecture leaves an upgrade path; no build now.
- **Watch and Sign in-class mode** (Watch → Plan → Record) — deferred; warmup borrowing from static prompt infra likely when implemented.

---

## Implementation order (suggested)

1. Shared **`writePromptManagerSettingsBlob`** / **`writeFlashcardSettingsBlob`** + **`resolveAssignmentIdByName`**.
2. Pipeline 1 (simplest; validates write path + stale warnings).
3. Pipeline 2 + UI for conflicts/unmatched.
4. **`watch_and_sign`** mode + config/DTO + Timer/recorder behavior.
5. Pipeline 3 detection + HTML parsers + module/LTI/Page mutations (behind strong confirmations).
6. Production bank generation + approval UI + persistence verification.
