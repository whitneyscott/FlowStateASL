---
name: Programmatic Launch Mapping
overview: Add a narrow post-sync step in `putConfig` that derives `resourceLinkId` from a programmatic sessionless launch and immediately persists the `resourceLinkId -> assignmentId` mapping when available, with `prompt-decks` logs only.
todos:
  - id: add-token-store-import
    content: Add getLtiToken import to prompt.service.ts
    status: pending
  - id: add-programmatic-launch-helper
    content: Implement private helper to sessionless-launch, follow redirects, parse lti_token, resolve context, and map resourceLinkId
    status: pending
  - id: invoke-helper-after-sync
    content: Invoke helper after each successful syncPrompterLtiModuleItem path in putConfig
    status: pending
  - id: ensure-required-prompt-decks-logs
    content: Emit exact success/skip prompt-decks messages with diagnostic fields
    status: pending
isProject: false
---

# Add Programmatic Launch Mapping In putConfig

## Scope

- Touch only `[apps/api/src/prompt/prompt.service.ts](c:/dev/FlowStateASL/apps/api/src/prompt/prompt.service.ts)`.
- Reuse existing Canvas method `[getSessionlessLaunchForModuleItem](c:/dev/FlowStateASL/apps/api/src/canvas/canvas.service.ts)` and token store lookup `[getLtiToken](c:/dev/FlowStateASL/apps/api/src/lti/lti-token.store.ts)`.
- Preserve existing flow/markers; insert one additional step after each successful `syncPrompterLtiModuleItem(...)` call in `putConfig`.

## Proposed implementation (before edits)

- **Import token resolver** in `prompt.service.ts`:
  - `import { getLtiToken } from '../lti/lti-token.store';`
- **Add a private helper** in `PromptService` (single responsibility):
  - Name: `saveResourceLinkMappingViaProgrammaticLaunch(...)`
  - Inputs: `courseId`, `moduleItemId`, `assignmentId`, `domainOverride`, `token`
  - Behavior:
    1. Call `this.canvas.getSessionlessLaunchForModuleItem(courseId, moduleItemId, domainOverride, token)`.
    2. Read `sessionless.url`; if absent => log skip under `prompt-decks` and return.
    3. Follow redirects with `fetch(url, { redirect: 'follow' })`, capture final URL via `response.url`.
    4. Parse `lti_token` from final URL query params.
    5. `const tokenCtx = getLtiToken(ltiToken)`.
    6. `const resourceLinkId = (tokenCtx?.resourceLinkId ?? '').trim()`.
    7. If non-empty, call existing `rememberResourceLinkAssignmentMapping(courseId, resourceLinkId, assignmentId, domainOverride, token)`.
    8. Log under `prompt-decks`:
      - success: `'resourceLink mapping saved via programmatic launch'` (+ `resourceLinkId`, `assignmentId`, `moduleItemId`)
      - skip: `'resourceLink mapping skipped: no resourceLinkId from programmatic launch'` (+ reason context)
- **Call helper in both `putConfig` sync success paths**:
  - After first path’s `ensuredTool = await this.canvas.syncPrompterLtiModuleItem(...)` block, using `ensuredTool.itemId`.
  - After fallback path’s `ltiSync = await this.canvas.syncPrompterLtiModuleItem(...)` block, using `ltiSync.itemId`.
  - Only invoke when `itemId` is present; otherwise log skip under `prompt-decks` with same required message.

## Proposed code shape (concise)

```ts
private async saveResourceLinkMappingViaProgrammaticLaunch(...) {
  const sessionless = await this.canvas.getSessionlessLaunchForModuleItem(...);
  const sessionlessUrl = String(sessionless?.url ?? '').trim();
  if (!sessionlessUrl) {
    appendLtiLog('prompt-decks', 'resourceLink mapping skipped: no resourceLinkId from programmatic launch', {...});
    return;
  }

  let finalUrl = sessionlessUrl;
  try {
    const r = await fetch(sessionlessUrl, { method: 'GET', redirect: 'follow' });
    finalUrl = String(r.url ?? sessionlessUrl);
  } catch {
    // best effort: keep sessionlessUrl
  }

  const token = new URL(finalUrl).searchParams.get('lti_token')?.trim() ?? '';
  const tokenCtx = token ? getLtiToken(token) : null;
  const resourceLinkId = (tokenCtx?.resourceLinkId ?? '').trim();
  if (!resourceLinkId) {
    appendLtiLog('prompt-decks', 'resourceLink mapping skipped: no resourceLinkId from programmatic launch', {...});
    return;
  }

  await this.rememberResourceLinkAssignmentMapping(...);
  appendLtiLog('prompt-decks', 'resourceLink mapping saved via programmatic launch', {...});
}
```

## Non-goals

- No changes to `CanvasService` logic.
- No changes to assignment resolution chain behavior.
- No changes to existing placement markers or other log categories.

