---
name: Flashcard Fixes LTI Save Decks Progress
overview: "Address three issues: (1) LTI tool not saving results to Canvas when students complete decks, (2) decks showing wrong playlist content, and (3) progress display not showing total/completed before Start."
todos: []
isProject: false
---

# Flashcard Fixes: LTI Save, Deck Contents, Progress Display

## Execution Summary (Completed)

- **1. Publish Flashcard Progress:** Done — `published: true` in ensureFlashcardProgressAssignment
- **2. LTI save reliability:** Done — getEffectiveCanvasToken for comment ops; errors propagated; frontend checks response and shows saveError
- **3. Deck content consistency:** Done — consistent ID handling (String comparison); flashcard.controller rejects empty playlist_id
- **4. Progress display:** Done — GET /api/flashcard/progress; deckProgress shown before Start as "X of Y cards"; getDeckProgress uses latest session per deck (by submittedAt)

## 1. Publish Flashcard Progress Assignment

**Problem:** Canvas blocks submission comments on unpublished assignments.

**Change:** In [apps/api/src/canvas/canvas.service.ts](apps/api/src/canvas/canvas.service.ts), update `ensureFlashcardProgressAssignment` to pass `published: true` instead of `published: false` to `createAssignment`.

---

## 2. LTI Progress Not Saving to Canvas (Even When Assignment Published)

**Current flow:**

- Frontend calls `POST /api/submission` when `view === 'results'` (see [apps/web/src/pages/FlashcardsPage.tsx](apps/web/src/pages/FlashcardsPage.tsx) lines 438-471).
- Backend uses `saveProgressToCanvas`, which tries `putSubmissionComment` (add comment to existing submission) or falls back to `createSubmissionWithComment` (create submission with comment).
- Errors are caught and swallowed; the frontend does not check the response.

**Root causes (saving fails even with published assignment):**

1. **Wrong Canvas token:** `putSubmissionComment` and `createSubmissionWithComment` always use global `CANVAS_API_TOKEN`; they do NOT use the teacher's Canvas token from course settings.
2. **Silent error swallowing:** All errors in `saveProgressToCanvas` are caught and swallowed; zero visibility.
3. **Frontend ignores response:** The frontend does not check `response.ok`; users never see when save fails.

**Planned changes:**

### 2a. Use course Canvas token for comment operations

- Add `tokenOverride` param to `putSubmissionComment` and `createSubmissionWithComment` in canvas.service.ts.
- In `saveProgressToCanvas`: get effective Canvas token from course settings (teacher's token or global) and pass to both Canvas methods.

### 2b. Surface save failures

- In [apps/api/src/submission/submission.service.ts](apps/api/src/submission/submission.service.ts): stop swallowing errors in `saveProgressToCanvas`; log them and rethrow or return error info.
- In [apps/web/src/pages/FlashcardsPage.tsx](apps/web/src/pages/FlashcardsPage.tsx): check the response from `POST /api/submission`, show an error toast/message if save fails, and avoid setting `submittedForSessionRef.current = true` when save fails so the user can retry.

### 2b. Ensure comments can be added/updated

- Canvas comments are append-only; each completion adds a new comment. This satisfies “update without repeated submissions” as long as we can add comments.
- Ensure `putSubmissionComment` uses the correct Canvas API: `PUT /submissions/:user_id` with `comment: { text_comment }`. If there is no submission yet, `createSubmissionWithComment` creates one. With the assignment published (section 1), both should work.
- Add structured logging around `saveProgressToCanvas` (assignment ID, user ID, Canvas response status) to aid debugging.

---

## 3. Decks Showing Wrong Playlist Content

**Current flow:**

- Deck items come from either: (a) cached `filteredPlaylistsWithItems` from course-settings, or (b) `GET /api/flashcard/items?playlist_id=X`.
- Course-settings builds `filteredPlaylists` from `fetchAllPlaylists`; each playlist `p` gets `items: p.videos.map(...)`.
- API `getPlaylistItems(playlistId)` fetches SproutVideo `GET /playlists/{id}` and then each video in `videos`.

**Potential causes:**

- ID mismatch (string vs number) when matching playlists: `filteredPlaylistsWithItems.find(p => p.id === id)`.
- Caching: hub cache keyed by `courseId`; if playlist IDs change or data is stale, cached items may be wrong.
- Wrong `playlist_id` passed from frontend when selecting a deck.

**Planned changes:**

### 3a. Consistent ID handling

- In [apps/api/src/flashcard/flashcard.controller.ts](apps/api/src/flashcard/flashcard.controller.ts) `getItems`: coerce `playlistId` to string and reject empty values.
- In [apps/web/src/pages/FlashcardsPage.tsx](apps/web/src/pages/FlashcardsPage.tsx): when looking up cached playlists, compare `String(p.id) === String(id)`.
- In [apps/api/src/sproutvideo/sproutvideo.service.ts](apps/api/src/sproutvideo/sproutvideo.service.ts) `getPlaylistItems`: ensure playlist ID is string when calling the SproutVideo API.

### 3b. Validation and logging

- In `getPlaylistItems`: after fetching a playlist, validate that returned video IDs match `data.videos`; log if mismatched.
- Add server logs for `playlist_id` and number of items returned.
- Prefer live API fetch over cached items when opening a deck: always call `GET /api/flashcard/items?playlist_id=...` to load items, and use cache only for deck list (not item content). This reduces risk of serving wrong items from cache.

### 3c. Reduce reliance on cached items for deck content

- In `selectPlaylist`: when cached items exist but have no embeds (new format), always fetch from `GET /api/flashcard/items` for items instead of building embeds from cached IDs. That ensures titles and embeds come from SproutVideo for the requested playlist.
- When cached items have embeds (legacy): continue using them, but consider adding a “Refresh” option to re-fetch from the API if users report wrong content.

---

## 4. Progress Display: Total and Completed Before Start

**Current behavior:**

- Progress shows only during study: `Progress: score.correct / score.total` and `Item currentIndex+1 of items.length`.
- Before Start, `score.total` is 0 and `currentIndex` is -1, so display is misleading.

**Desired behavior:**

- Before Start, show “X of Y cards” where Y = total cards in the deck and X = cards the student has completed for this deck (from prior sessions).
- Total Y is available as `items.length` once the deck is loaded.
- Completed X must come from stored progress (Canvas comments or DB).

**Planned changes:**

### 4a. API to fetch deck progress

- Add `GET /api/flashcard/progress?course_id=...&user_id=...` (or use session for user).
- Backend: read the Flashcard Progress assignment submission comments for the user, parse JSON comments (`deckIds`, `score`, `scoreTotal`), aggregate per deck ID, and return `{ [deckId]: { completed: number, lastScore?: number } }`.
- Or add `deck_ids[]` query param and return progress only for those decks.

### 4b. Frontend progress display

- When a deck is selected and `items` are loaded, call the progress API for that deck (or for all decks in the hub).
- Store `deckProgress: Record<string, { completed: number }>` in component state.
- Before Start (`currentIndex < 0`): show “X of Y cards completed” where X = `deckProgress[deckId]?.completed ?? 0` and Y = `items.length`.
- During study: keep existing “Progress: correct / total” and “Item N of total”.
- Ensure X does not exceed Y (cap at Y).

### 4c. Progress semantics

- “Completed” = number of cards the student has studied in prior sessions for this deck. Options:
  - **A:** Count sessions: each session completion = 1 “run” (simpler, but not per-card).
  - **B:** Sum `scoreTotal` across sessions (cards attempted per session) — may double-count if student repeats.
  - **C:** Use latest session’s `scoreTotal` as “cards in last run” and treat as “completed once” — clearer for “X of Y” if Y is deck size.
- Recommendation: use **C** or **A** for clarity. For “X of Y completed”, interpret X as “cards completed in most recent session” or “completed runs” depending on product intent. Document the chosen meaning in the plan and code comments.

---

## Implementation Order

1. Publish Flashcard Progress assignment (section 1).
2. Improve LTI save reliability and error handling (section 2).
3. Fix deck content consistency (section 3).
4. Add progress API and update display (section 4).

---

## Open Questions

1. **Progress semantics:** Should “X of Y completed” mean (a) cards in the last completed session, (b) cumulative cards across all sessions, or (c) number of sessions completed?
2. **Deck content:** Do you have a concrete example (playlist name, expected vs actual items) to narrow down the wrong-content issue?

