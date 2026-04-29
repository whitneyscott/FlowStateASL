# Prompt Manager UX — implementation phases (test in Canvas between phases)

**Goal:** Approachable setup for non-technical instructors, with an **optional multi-screen wizard** later so users can choose guided vs classic layout.

## Phase 1 — Blocking settings: clear feedback (shipped in this PR)

- Single **client validation** helper aligned with Save (`module`, deck count in deck mode, YouTube URL + clip window).
- **Inline** error copy and **red outline** on the section that blocks Save.
- On blocked Save (or **Create Assignment** with no module): **scroll** to that section and **focus** the primary control (module select, deck panel, YouTube URL or clip end).
- Top **alert** keeps `role="alert"` for screen readers.

**How to test in Canvas:** Edit an assignment; try Save with no module, deck mode and zero decks, YouTube mode with empty URL or invalid clip; confirm scroll/focus and inline message. Fix each issue and confirm hints clear when valid.

## Phase 2 — Foundation-first layout + optional wizard entry

- Reorder UI: **module + access + prompt mode** before heavy editors; optional **“Step-by-step setup”** that switches to a **multi-step wizard** (same data, different chrome), with **“Classic (all on one page)”** to opt out.
- Gate or disable mode-specific content until foundation is complete (or show one-line “complete the steps above”).

## Phase 3 — Collapsible “Canvas assignment details” + advanced blocks

- Collapse points, dates, attempts, instructions, rubric into **“Assignment details (optional)”**.
- Default-collapsed **deck filters**, **YouTube advanced**, **sign-to-voice** per earlier approachability plan.

## Phase 4 — Copy, sticky save, empty state

- Plain-language H1/subtitle, import modal lead-in, tooltips for jargon.
- **Sticky** Save row (or duplicate at top).
- **Empty assignments** short “Start here” panel.

## Phase 5 — QA pass

- Non-dev walkthrough; verify wizard optional path and Save blocking parity with Phase 1.
