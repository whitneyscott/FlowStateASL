# Flashcard To-Do

## Stage 1: Core Logic & Player Enforcement

⬜ SproutVideo IFrame Bridge: Implement window.addEventListener('message') in the Viewer to capture the completed/ended signals.

⬜ Video Playback Enforcement: Create canAdvance state. Disable the "Next" button and prevent auto-advance in "Tutorial Mode" until the signal is received.

⬜ Clean Architecture: Move all spinner, layout, and disabled-state styling into .css files. (Zero inline styles, no comments).

⬜ Loading Spinner: Create .spinner class and display it in TeacherSettings.tsx while data is fetching.

## Stage 2: Interface & Navigation Restoration

⬜ Reset & Pause: Restore the "Reset Deck" button and add "Pause/Replay" to Tutorial and Rehearsal modes.

⬜ Topic Header: Put the Playlist title at the top of the Deck while it's in use.

⬜ Playlist View: Add "View as Playlist" toggle to the initial selection window.

⬜ Change Deck Optimization: Cache the list of playlists so "Change Deck" doesn't trigger a full reload.

⬜ Video Display Logic: Add option to present only one version if multiple videos have the same English answer.

## Stage 3: Teacher Settings & Permissions

⬜ "View as Student" Toggle: Hide teacher dropdowns and apply student visibility rules when active.

⬜ Settings Labeling: Ensure all toggles use ONLY "Show" and "Hide."

⬜ Curriculum Fallback: Restore using the module's title for suggestions but fallback to dropdowns.

⬜ Point Awards: Add teacher setting to decide how to award points.

## Stage 4: Progress Tracking & Submission

⬜ Canvas Integration: Logic to check for the "Flashcard Progress" assignment. Create it if missing.

⬜ Data Storage: Implement saving to Canvas comments using the established JSON schema (Browser Session + UUID).

⬜ Tutorial Scoring: Ensure Tutorial mode does not award 100% credit.

## Stage 5: Expressive Mode & AI

⬜ Expressive Recorder: Add recorder, AI scoring, rubric scoring, and timestamped annotations.

⬜ AI Activation: Implement Exact match, Embeddings, and the Reranker.

⬜ Typed Input: Add autoscoring (Strict, then Fuzzy/AI assisted).
