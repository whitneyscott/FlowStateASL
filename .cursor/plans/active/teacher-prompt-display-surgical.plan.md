# Teacher prompt display — surgical fix (no wholesale revert)

## User constraints

- **Do not** “revert to commit X” or replace whole files with an old snapshot (avoids reintroducing unknown broken state from a “rough night”).
- **Do** learn from commits that *demonstrated* working prompt display and **apply only those mechanisms**, with the **smallest possible diff** elsewhere.
- **Do not** change unrelated behavior (other pages, API, debug logging, etc.) unless this task strictly requires it.

## What actually fixed prompt display (extract the mechanism, not the old file)

From history, the **behavior** that made async-loaded HTML show in the text fields was:

1. **react-quill remount on config load** — A key tied to “we just applied `GET /config`” so the editor is not left blank when `value` arrives after async fetch.
   - **Current code already has this:** `remountKey` on `ReactQuill`, `promptRteRemountKey` in [`TeacherConfigPage.tsx`](../../apps/web/src/pages/TeacherConfigPage.tsx) incremented in `load()` after applying config, per-row and instructions `remountKey` strings.
   - **Action:** Verify these are still present and correct; **no removal**, no refactors of `load` unless a gap is found.

2. **Correct assignment targeting** — Teacher UI must use the **intended** Canvas assignment id (URL `?assignmentId=` preferred over stale LTI context) so `GET /config` fetches the assignment whose description contains the ASL embeds.
   - **Already implemented** in TeacherConfig: URL first, then context.
   - **Action:** **No code churn** here unless a bug is proven.

3. **Boot effect stability** — `useEffect` that calls `load` should depend on stable inputs (`teacher`, `hasLti`, `assignmentId`) so config isn’t re-fetched spuriously or in bad order.
   - **Action:** **No change** if still `[teacher, hasLti, assignmentId]`.

**If prompts still don’t show** while Bridge/API show `textPromptsCount > 0`, the remaining issue is **editor layer**, not missing remount/assignment (unless verification finds a gap).

## Likely regression: font-size change (9f1afc5), *without* reverting the feature

The follow-up **font-size** work added a **second** `quill` import path and `import { SizeStyle } from 'quill/formats/size'` + `Quill.register('formats/size', …)`. That can produce **two Quill module instances** in the bundle, where format registration and `ReactQuill` disagree — a common way to get **empty Quill** despite correct React `value`.

**Surgical fix (forward-only, keep font size intent):**

1. In [`apps/web/vite.config.ts`](../../apps/web/vite.config.ts), add `resolve.dedupe: ['quill']` so a **single** `quill` instance is used (minimal config change, doesn’t “revert” anything).
2. In [`apps/web/src/components/TeacherPromptRte.tsx`](../../apps/web/src/components/TeacherPromptRte.tsx), **replace only** the SizeStyle wiring with the pattern that uses the **same** Quill registry `react-quill` uses, e.g. (as in `cf5ab4c` / feature work):
   - `const SizeStyle = Quill.import('attributors/style/size')` (adjust types as needed)
   - extend `SizeStyle.whitelist` with the desired pixel list
   - `Quill.register({ 'formats/size': SizeStyle }, true)` (object form)
   - **Remove** the separate `import { SizeStyle } from 'quill/formats/size'` if it duplicates the instance used by the registry
3. **Do not** remove the size toolbar, `size` in `FORMATS`, or `remountKey` unless a follow-up test proves they conflict.

**No** wholesale deletion of the font-size feature; **no** file rollback to 77ac90c.

## What not to do

- Do not remove Bridge / server `prompt-manager-config` logging as part of this.
- Do not change [`prompt.service.ts`](../../apps/api/src/prompt/prompt.service.ts) embed pipeline unless a new failure mode is identified (user logs already showed correct prompt counts for text assignments).
- Do not refactor `TeacherConfigPage` state shape beyond what’s required to fix display.

## Verification

- Open Prompt Manager, text-mode assignment with known embedded prompts; confirm HTML appears in each prompt field after load.
- Smoke-test: add prompt, save, reload — still works.
- Optional: confirm size dropdown still works after registry/dedupe change.

## Todos (execution order)

1. **Verify** remount + URL-first + load effect in `TeacherConfigPage` (read-only check; only patch if something is missing).
2. **Add** `resolve.dedupe: ['quill']` in `vite.config.ts`.
3. **Surgical** `TeacherPromptRte` SizeStyle: `Quill.import('attributors/style/size')` + whitelist + `Quill.register({ 'formats/size': SizeStyle }, true)`; remove redundant `quill/formats/size` import if present.
4. **Build** `nx run web:build` and manual UI check as above.
