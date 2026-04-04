# Deck-Based Prompts Implementation Plan

## Overview

This feature enables ASL assessment using flashcard decks as the source of words. The student sees an English word on screen and expresses it in ASL while being recorded. **No videos are played** — the flashcard decks serve only as the source of words, and SproutVideo metadata provides timing for each word.

## Completed: Part 1 — Data Model Changes

### Files Modified

1. **`apps/api/src/prompt/dto/prompt-config.dto.ts`**
   - Added `VideoPromptConfig` interface
   - Extended `PromptConfigJson` with `promptMode` and `videoPromptConfig`
   - Extended `PutPromptConfigDto` with the same fields

2. **`apps/api/src/prompt/prompt.service.ts`**
   - Updated `putConfig()` to handle new fields
   - Updated `getConfig()` to default `promptMode` to `'text'` for backward compatibility

### Data Model

```typescript
interface VideoPromptConfig {
  selectedDecks: Array<{ id: string; title: string }>;
  totalCards: number;
}

interface PromptConfigJson {
  // ... all existing fields ...
  promptMode?: 'text' | 'decks'; // defaults to 'text' if absent
  videoPromptConfig?: VideoPromptConfig;
}
```

---

## Remaining Parts

### Part 2 — Prompt Selection Algorithm
- Fetch all cards from selected decks
- Deduplicate within each deck by English title (case-insensitive)
- Shuffle each deck randomly
- Select cards in round-robin order across decks
- Skip duplicates (if title already in prompt list)
- Stop when `totalCards` reached OR all decks exhausted
- Show warning if can't reach `totalCards`
- Final shuffle of selected prompts

### Part 3 — Timing Model
- `totalPromptTime = 1.5s + videoDuration`
- Fetch video duration from SproutVideo API
- Fallback: 3 seconds if duration unavailable
- Pre-fetch ALL durations before session starts

### Part 4 — Recording Architecture
- ONE continuous recording for entire session
- Timestamp each word appearance
- Store timestamps for teacher navigation during grading
- Clear transition signal between words

### Part 5 — Teacher Configuration UI (deck picker — align with Flashcards hub)

**Problem observed:** Curriculum/units show in Prompt Manager, but **sections** are missing and **available decks** can read **0** because the picker was wired to `GET /api/flashcard/curricula`, `units`, and `teacher-playlists` only. That path has no `section` dimension, and CSV query params plus `split(',')` without `decodeURIComponent` can yield **encoded** values that do not match DB strings (e.g. spaces → `%20`), which can empty the deck list.

**Do not duplicate hierarchy logic.** Reuse the same data source and filtering behavior as the flashcard player:

1. **Data load (same pipeline as flashcard hub):** Call existing [`GET /api/flashcard/student-playlists-batch`](apps/api/src/flashcard/flashcard.controller.ts). Use **`showHidden=1`** if the prompt picker should list **all** decks in the cache (teacher building assignments). Use **`showHidden=0`** if it should mirror **student-visible** decks only (same course-settings constraints as the batch path when not hidden). In both cases the response includes **curriculum, unit, section** per row via [`getPlaylistsByCurriculaAndUnitsWithHierarchy`](apps/api/src/sproutvideo/playlist-cache.service.ts) — the same shape [`FlashcardsPage.tsx`](apps/web/src/pages/FlashcardsPage.tsx) already maps into `allPlaylistsWithHierarchy`.

2. **Filtering (same as Flashcards):** Reuse the **exact derivation pattern** in [`FlashcardsPage.tsx`](apps/web/src/pages/FlashcardsPage.tsx) `useMemo` (~lines 185–218): from `allPlaylistsWithHierarchy`, compute distinct **curricula** → filter by selected curricula → distinct **units** → filter by selected units → distinct **sections** → filter by selected sections → **filteredPlaylists** (`id` + `title`). Optionally extract a small shared helper or hook (`useDeckHierarchyFilters`) used by both FlashcardsPage and TeacherConfigPage to avoid drift.

3. **OAuth / token errors:** Keep using the same fetch + `NeedsManualTokenError` / OAuth redirect handling as today when calling the batch endpoint from Prompt Manager.

4. **Remove or demote** the separate `flashcard-teacher.api.ts` **teacher-playlists** chain for this picker once the batch + client filter path is in place (or leave only curricula if still needed elsewhere — prefer one hierarchy source).

**Deferred (separate plan):** Auto-create/sync Canvas rubric to `totalCards` on save — hold until deck picker matches Flashcards behavior.

**Checklist**

- [ ] Prompt Manager deck mode: section multi-select row (parity with Flashcards hub).
- [ ] Available decks count matches filtered hub after curriculum + unit + section selection.
- [ ] No reliance on undecoded CSV for hierarchy (batch JSON uses plain strings).

### Part 6 — Student Experience
- Extend TimerPage for decks mode
- Show English word with timing
- Transition signals between words
- Text mode completely unchanged
- No video playback — words only