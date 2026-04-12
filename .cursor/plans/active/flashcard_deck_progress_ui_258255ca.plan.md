---
name: Flashcard deck progress UI
overview: The flashcard menu today shows full-width deck buttons and only loads coarse per-deck data when a deck is opened; the API’s `completed` value is the stored session `scoreTotal`, not an 80% mastery flag. This plan adds persistent rehearsal ≥80% tracking split by first side (English vs ASL), surfaces two read-only checkboxes per filtered deck with batch progress fetch, and sizes deck buttons to the widest visible title via CSS grid.
todos:
  - id: api-deck-result
    content: Add firstSide to SubmitFlashcardDto; extend DeckResult + mergeDeckResult for rehearsal ≥80% per english/asl; keep latched trues
    status: pending
  - id: api-get-progress
    content: Extend FlashcardService.getDeckProgress to parse and return englishFirst80 / aslFirst80 (and keep completed)
    status: pending
  - id: web-submit-fetch
    content: "FlashcardsPage: include firstSide in submit payload; batch GET progress for studyDeckList; merge into state"
    status: pending
  - id: web-ui-css
    content: "Deck rows: two disabled checkboxes + button; CSS grid max-content column for equal button widths; hub + assignment list paths"
    status: pending
  - id: verify-build
    content: Run nx builds for api and web
    status: pending
isProject: false
---

**Canonical location (repo):** [`.cursor/plans/active/flashcard_deck_progress_ui_258255ca.plan.md`](flashcard_deck_progress_ui_258255ca.plan.md) (Windows: `FlowStateASL\.cursor\plans\active\`). If Cursor also created a copy under your user profile `.cursor/plans/`, treat **this repo file** as the source of truth to commit and execute.

# Flashcard student progress: dual checkboxes + compact deck buttons

## Current behavior (findings)

- **Menu list:** Students in course navigation use [`studyDeckList`](apps/web/src/pages/FlashcardsPage.tsx) (`filteredPlaylists` when hub mode). Deck rows are plain [`flashcards-playlist-btn`](apps/web/src/pages/FlashcardsPage.css) with **`width: 100%`** inside a column flex list.
- **Progress data:** [`silentSubmitProgress`](apps/web/src/pages/FlashcardsPage.tsx) POSTs to `/api/submission` with `mode`, `score`, `scoreTotal`, `deckIds`, etc., but **no `firstSide`**. [`mergeDeckResult`](apps/api/src/submission/submission.service.ts) persists a `DeckResult` per deck (including `rehearsalBestScore`) into Canvas submission body `{ results: { [deckId]: ... } }`.
- **GET progress:** [`FlashcardService.getDeckProgress`](apps/api/src/flashcard/flashcard.service.ts) reads that JSON and returns `{ [deckId]: { completed } }` where `completed` is **`deckResult.scoreTotal`** (denominator of the last write), **not** “cards mastered” or an 80% threshold. The study header line that mixes `deckProgress[...].completed` with `deckTotalFromCache` is therefore easy to misread; your new checkboxes address the real student-facing “did I pass rehearsal for this side?” question.

```291:340:apps/api/src/flashcard/flashcard.service.ts
  async getDeckProgress(
    ...
        const parsed = JSON.parse(rawBody) as {
          results?: Record<string, { scoreTotal?: number }>;
        };
        ...
          const completed =
            deckResult && typeof deckResult.scoreTotal === 'number'
              ? deckResult.scoreTotal
              : 0;
          result[id] = { completed };
```

## Target behavior

1. **Two read-only checkboxes per visible deck** (after hub/assignment filtering): **English first** and **ASL first**, checked when the student has completed a **rehearsal** run with **≥ 80%** correct (`score / scoreTotal >= 0.8`) for that deck **with that `firstSide`**. Tutorial/screening do not set these flags.
2. **Latch true:** Once a side reaches ≥80%, keep it checked on later merges (same pattern as `rehearsalBestScore`—do not clear on a worse run).
3. **Deck buttons:** Not full viewport width; **all deck buttons in the list share a width equal to the widest title** among currently visible decks (CSS grid column `max-content` over rows).

## Implementation

### 1. Persist first-side mastery in Canvas JSON

- Extend [`DeckResult`](apps/api/src/submission/submission.service.ts) with booleans, e.g. `rehearsalEnglishFirst80?: boolean` and `rehearsalAslFirst80?: boolean` (names can be shortened in JSON if you prefer snake_case in storage—keep API response stable for the web).
- Extend [`SubmitFlashcardDto`](apps/api/src/submission/dto/submit-flashcard.dto.ts) with optional `firstSide?: 'english' | 'asl'`.
- In **`mergeDeckResult`**: when `mode === 'rehearsal'`, `scoreTotal > 0`, and `(score / scoreTotal) >= 0.8`, set the flag for `dto.firstSide` to `true`, preserving any existing `true` from `existing` for either side.

### 2. Expose flags from GET `/api/flashcard/progress`

- Widen parsing in [`getDeckProgress`](apps/api/src/flashcard/flashcard.service.ts) to read the new booleans and return something like `{ [deckId]: { completed: number; englishFirst80?: boolean; aslFirst80?: boolean } }` (keep `completed` for backward compatibility with the existing study header unless you choose to simplify that line in the same change).

### 3. Web: send `firstSide` and batch-load menu progress

- In [`silentSubmitProgress`](apps/web/src/pages/FlashcardsPage.tsx), add `firstSide` from component state to the JSON body.
- Add state (or reshape `deckProgress`) for menu rows, e.g. `Record<string, { completed?: number; englishFirst80?: boolean; aslFirst80?: boolean }>`.
- **`useEffect`** keyed on **`studyDeckList`** (and course context): when the list of deck IDs is non-empty, call  
  `GET /api/flashcard/progress?deck_ids=${ids.map(encodeURIComponent).join(',')}`  
  once per list change (optional short debounce if filter churn is noisy).
- Keep the existing per-deck fetch on `selectPlaylist` if you still want immediate refresh after a run, or rely on menu refetch when returning to menu—pick one consistent approach to avoid stale UI.

### 4. UI: row layout + CSS

- Replace each standalone deck `<button>` with a **row wrapper** (two places: `filteredPlaylists.map` and `playlists.map` in the menu) containing:
  - Disabled **checkbox + “Eng”** label (checked from `englishFirst80`)
  - Disabled **checkbox + “ASL”** label (checked from `aslFirst80`)
  - Existing deck button (same `selectPlaylist` handler)
- Use a **single CSS Grid** for the whole list: `grid-template-columns: auto auto max-content` so column 3 width = **max of all deck titles**. Place each row’s three cells in DOM order (flat grid children) **or** use one wrapper per row with an inner grid using the same column template—either works; flat grid is fewer wrappers.
- Update [`FlashcardsPage.css`](apps/web/src/pages/FlashcardsPage.css): remove forced `width: 100%` from `.flashcards-playlist-btn` where it conflicts; set list container `width: max-content; max-width: 100%` so long courses still scroll/wrap viewport. Mirror compact playlist styles.

### 5. Verification

- From repo root: `npm exec nx run api:build` and `npm exec nx run web:build`.
- Manual: rehearsal with `firstSide` English, score ≥80% → Eng checkbox checks after save; switch to ASL first, another ≥80% run → ASL checks; &lt;80% does not clear a previously checked box.

## Notes / non-goals

- **80% vs `calculateRehearsalThreshold` (85%)** in [`submission.service.ts`](apps/api/src/submission/submission.service.ts): the 85% helper is separate from this feature; use **0.8** explicitly for the new flags unless you decide to centralize a named constant.
- Checkboxes are **indicators of saved progress**, not editable toggles (unless you later add teacher override).
