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
