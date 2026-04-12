# Plans Directory Map

**Canonical location in this repo:** `.cursor/plans/` (Windows: `FlowStateASL\.cursor\plans`). All plan material lives here—not under a top-level `plans/` folder.

**New plans:** Save newly created plan files under **`.cursor/plans/active/`** unless the project owner specifies a different path.

This directory separates active plans, setup/how-to docs, archived/superseded plans, and non-plan key artifacts.

## Structure

- `.cursor/plans/active/`: Current plans and operational docs with incomplete work.
- `.cursor/plans/setup/`: How-to and setup documentation.
- `.cursor/plans/archive/`: Superseded investigations/plans kept verbatim for historical context.
- `.cursor/plans/LESSONS_LEARNED.md`: Cross-cutting historical lessons kept at the plans root.
- `developer-keys/` (outside `plans/`): Canvas Developer Key JSON and related key setup notes.

## Quick Index

### Active

| File | Focus |
|------|-------|
| `.cursor/plans/active/PromptManagerToDo.md` | Prompt Manager remaining roadmap items |
| `.cursor/plans/active/FlashcardToDo.md` | Flashcards unfinished feature backlog |
| `.cursor/plans/active/prompt-manager-sproutvideo-fallback.plan.md` | Prompt Manager fallback and reliability follow-up |

### Setup

| File | Focus |
|------|-------|
| `.cursor/plans/setup/LTI_SETUP_CANVAS.md` | LTI setup baseline for Canvas |
| `.cursor/plans/setup/LTI_1.3_DEV_SETUP_WALKTHROUGH.md` | Local LTI 1.3 dev setup walkthrough |
| `.cursor/plans/setup/LTI_1.3_PROMPT_MANAGER_CANVAS_SETUP.md` | Prompt Manager-specific Canvas setup |
| `.cursor/plans/setup/HOWTO-SEED-DATABASE.md` | Database seeding including QTI seeding |

### Archived Milestones

| File | Why it matters |
|------|----------------|
| `.cursor/plans/archive/announcement-based_flashcard_settings_778499cb.plan.md` | Captures delivered announcement-primary settings architecture |
| `.cursor/plans/archive/assignment-description-settings-storage.plan.md` | Records delivered assignment-description settings path |
| `.cursor/plans/archive/QTI-SEED-PLAN.md` | Records completed QTI parser + seed workflow |
| `.cursor/plans/archive/DeckPromptsPlan.md` | Deck prompt picker parity work completed and archived |
| `.cursor/plans/archive/lti-flow-analysis.plan.md` | Historical analysis context for LTI launch/submission behavior |

## Why Items Were Archived

- Duplicated planning docs were archived when a newer canonical version existed.
- Investigation-only docs were archived after conclusions were captured in implementation and lessons learned.
- Strategy docs tied to retired approaches were archived once replaced by the unified assignment-anchor strategy and version-aware fallback chain.
- Migration planning docs were archived after execution moved to operational follow-up and active implementation docs.

## Operating Rules

- Archived files are moved verbatim (no content edits).
- Active files stay in `.cursor/plans/active/` for current execution.
- How-to/setup docs belong in `.cursor/plans/setup/`.
- Files with completed checklists move to `.cursor/plans/archive/` unless they are setup/how-to docs.
- New historical investigations should be added to `.cursor/plans/archive/` once superseded.
