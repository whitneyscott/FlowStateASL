# Flashcard To-Do

## Phase 1: Infrastructure & Stability (The "Grand Vision" Foundation)

⬜ Migrate to Render: Move NestJS backend and React frontend to resolve 403 errors and enable automated deployments.

⬜ Clean Architecture: Ensure zero inline styles; move all spinner, layout, and disabled-state styling to respective .css files. (No code comments).

⬜ Dashboard Conversion: Convert to a dashboard interface and deeplink to the TWA modules tool.

## Phase 2: Teacher UI & Global Settings

⬜ Teacher Settings Module: Create settings interface (matching Prompt Manager style).

⬜ Curriculum/Playlist selection.

⬜ "Require Full Playback" toggle (Labeling: "Show" / "Hide" only).

⬜ Logic to decide how to award points.

⬜ "View as Student" Toggle: Implement teacher preview mode (Labeling: "Show" / "Hide" only).

⬜ Loading Logic: Implement CSS Spinner in TeacherSettings.css. Apply spinner in TeacherSettings.tsx while loading is true; hide controls during fetch.

## Phase 3: Flashcard Viewer & UX (The "Gym")

⬜ SproutVideo IFrame Bridge: Implement window.addEventListener('message') to capture completed/ended signals.

⬜ Video Playback Enforcement: Implement canAdvance state (initially false). Disable "Next" button and block auto-advance in Tutorial Mode until canAdvance is true.

⬜ UI Restoration: Restore "Reset Deck" button. Add "Pause" and "Replay" buttons to Tutorial and Rehearsal modes.

⬜ Playlist Navigation: Add "View as Playlist" toggle at the opening selection window. Put the Topic (Playlist title) at the top of the Deck during use. Cache playlist list to prevent full reloads when choosing "Change Deck."

⬜ Smart Display: Add option to present only one version if multiple videos have the same English answer.

## Phase 4: Data Persistence & Progress Tracking

⬜ Canvas Progress Integration: Check for/create "Flashcard Progress" assignment in Canvas for the student.

⬜ Store Progress in Comments: Use the Dual-ID schema (Browser Session + UUID).

⬜ LTI 1.3 Migration: Move data storage from Comments to AGS Metadata.

## Phase 5: Expressive Assessment & AI

⬜ Expressive Test Features: Teacher options for number of items and filtering. Add Recorder for student signing. Add Rubric scoring and timestamped annotations.

⬜ AI Logic Activation: Exact match -> Embeddings -> Reranker. AI scoring for expressive tests.

⬜ Tool Unification: Merge Flashcards and Prompt Recorder to allow English-to-ASL recording.

## Phase 6: Future Implementations (Linguistic Refinement)

⬜ Linguistic Buffer: Add "Slow-Mo Closure" replay (last 2 seconds at 0.75x).

⬜ Deck Search: Add "Quick Find" search bar to the Dashboard.

⬜ Confidence Rating: Implement 1–5 star metacognition tracking.

⬜ Teacher Heatmap: Aggregate error arrays for classroom-wide analytics.

⬜ Dynamic Mastery: Replace 100% Tutorial credit with a "Progress to Mastery" threshold.
