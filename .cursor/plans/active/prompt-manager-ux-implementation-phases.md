# Prompt Manager UX — implementation phases (test in Canvas between phases)

**Goal:** Approachable setup for non-technical instructors, with an **optional multi-screen wizard** later so users can choose guided vs classic layout.

## Phase 1 — Blocking settings: clear feedback (shipped in this PR)

- Single **client validation** helper aligned with Save (`module`, deck count in deck mode, YouTube URL + clip window).
- **Inline** error copy and **red outline** on the section that blocks Save.
- On blocked Save (or **Create Assignment** with no module): **scroll** to that section and **focus** the primary control (module select, deck panel, YouTube URL or clip end).
- Top **alert** keeps `role="alert"` for screen readers.

**How to test in Canvas:** Edit an assignment; try Save with no module, deck mode and zero decks, YouTube mode with empty URL or invalid clip; confirm scroll/focus and inline message. Fix each issue and confirm hints clear when valid.

## Phase 2 — Foundation-first layout + optional wizard entry (shipped)

- **Classic layout:** **Module, access code, and prompt source** sit in a highlighted **foundation** block above the two-column grid; **assignment details** stay in the left column; **text / deck / YouTube** editors in the right column. If no module is selected, the prompt column shows a warning and is **dimmed / non-interactive** until a module is chosen.
- **Step-by-step:** Toggle **Classic (one page)** vs **Step-by-step**; choice is stored in `localStorage` under `flowstateasl:teacher-prompt-config-ui`. Wizard steps: (1) foundation only, (2) assignment details only, (3) prompt content only. **Next** on step 1 requires a module (same messaging as Save). **Back / Next** between steps.
- **UI sync (module & group selects):** Boot loads **`GET /modules` → groups → rubrics → `GET /config`** in order so the module dropdown has options before config applies. **`configLoadGenRef`** drops stale config responses when switching assignments quickly. **`normalizeCanvasIdString`** on `moduleId` / group from config; **effects** align `moduleId` and `assignmentGroupId` with loaded lists; **orphan module option** if the saved id is missing from the list. **Import** calls **`loadModules()`** before **`load(sid)`** after a successful merge.

## Phase 3 — Collapsible “Canvas assignment details” + advanced blocks (shipped)

- **Canvas assignment details:** `<details>` — name, group, points, dates, attempts, instructions, rubric (collapsed by default; warm-up / deck mode note stays visible above).
- **Deck mode:** curriculum / unit / section filters in a **collapsed** `<details>`; total cards, available decks, and selected decks stay open.
- **YouTube mode:** student captions, subtitle mask, and sign-to-voice in **Recording & caption options (optional)** `<details>`; URL, preview, and clip controls stay open.
- **Bugfixes bundled:** module `<select>` uses **trimmed/normalized** `value` + `onChange` so the choice does not fall off options when IDs differ by whitespace; **prompt/instruction images** use **`sanitizeTeacherFeedbackHtmlForDisplay`** so signed `/view?sig=…` URLs are kept for readonly HTML (Quill already had signed URLs; preview was stripping `sig` and breaking `<img>`).

## Phase 4 — Copy, sticky save, empty state (shipped)

- Plain-language H1/subtitle, import modal lead-in, tooltips on prompt-type radios and foundation heading.
- **Sticky** Save/Reset row at the bottom of the configure card plus a **duplicate** row under the Classic / Step-by-step toggle; optional **unsaved changes** hint when the form differs from the last loaded config.
- **Empty assignments** “Start here” panel when the course has no Prompt Manager assignments yet.
- **Reset** calls `load` after a successful server reset so the form and baseline stay aligned.

## Phase 5 — QA pass

- Non-dev walkthrough; verify wizard optional path and Save blocking parity with Phase 1.
