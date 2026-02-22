# Flashcard To-Do

## Pre-Phase D — Flashcard UX & Tutorial Mode

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

## Flashcards — To Do

⬜ Add video controllers to the tutorial and to the videos in rehearsal mode when English is first  
⬜ Add "view as playlist" to flashcards — at opening window where student selects the playlist (toggle: playlist vs. flashcards)  
⬜ Restore the "reset deck" button  
⬜ Restore using module's title for curriculum/unit/section suggestion but fallback to the dropdowns  
⬜ Create teacher settings like the prompt manager has  
  - ✅ Choose curriculum (FS, Numbers, TWA, Signing Naturally, etc.)  
  - ⬜ Decide how to award points  
  - ⬜ Etc.  
⬜ Put the topic (Playlist title) at the top of the Deck as it is being used  
⬜ Don't reload the full list of playlists when user chooses "Change Deck". Either open each deck in a new tab OR keep the list of playlists in a cache.  
⬜ Convert to a dashboard interface and deeplink to the TWA modules tool  
⬜ Migrate to LTI 1.3  
⬜ Re-activate AI  
  - ⬜ Exact match  
  - ⬜ Embeddings  
  - ⬜ Reranker  
  - ⬜ LLM as rerank trainer  
⬜ Unify the flashcards and prompt recorder. That way can use the flashcards to record what students sign with English vocab.  
⬜ Add ability to pause in tutorial mode and replay a video.  
⬜ Fix the wait for video to finish feature — it's a problem in tutorial mode too  
⬜ Track progress in Canvas  
  - ⬜ When student uses flash cards — check to see if the Flashcard Progress assignment exists for the student. If not, create it.  
  - ⬜ Store the progress data in the comments  
  - ⬜ Use the schema:  
```json
{
  "version": "1.0",
  "browser_session_id": "92ea-419b-88d1",
  "last_updated": "2026-02-22T09:30:00Z",
  "sessions": [
    {
      "uuid": "7b2354c0-4067-11e9-9b5d-ab8dfbbd4bed",
      "date": "2026-02-22",
      "playlist": "TWA.05.03"
    }
  ]
}
```  
⬜ Add an option to present only one version if multiple videos in the deck have the same English answer  
⬜ Add Teacher options for expressive test — number of items to select, items to filter out  
⬜ Add a recorder for expressive tests  
  - ⬜ Add AI scoring  
  - ⬜ Add rubric scoring  
  - ⬜ Add annotation with time-stamp display  
⬜ Don't give 100% for Tutorial mode  
⬜ Add and use tags?

---

## Completed

✅ Shuffling — use in rehearsal mode  
✅ Reset totals for next deck  
✅ Fix the cross linking issue — opening the wrong app! AND fix the prompt manager  
✅ Show the prompts in the grading part of the assignment, but keep them from the students  
✅ If I create an assignment in one course, the prompts need to copy over to the next course  
✅ Add more font options such as size to the rich text editor  
✅ Add typed input with autoscoring  
  - ⬜ Strict first  
  - ⬜ Fuzzy logic next (Levenshtein distances?)  
  - ⬜ AI assisted  
  - ⬜ For expressive — gesture recognition  
✅ Fix module name parsing so only one bridge (canvas_bridge or sprout_bridge) does it
