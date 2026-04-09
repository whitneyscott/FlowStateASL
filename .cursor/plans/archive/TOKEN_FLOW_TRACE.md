# Token Flow Trace (historical — see current `CourseSettingsService.getEffectiveCanvasToken`)

## Call Chain (legacy note)

1. **`CanvasService.findAssignmentByTitle(courseId, title, domainOverride, tokenOverride)`**
   - `tokenOverride` is the 4th parameter.

2. **Current source (Nest):** `session.canvasAccessToken` first, then encrypted `course_settings.canvas_api_token` for the **same** `courseId` from LTI context. **No** `CANVAS_API_TOKEN` / shared env fallback.

3. **Older doc below** described env-only tokens; that path has been removed.

## The Problem

- **69-character token** → (Historical) often a mis-set env or wrong token type before OAuth/per-course storage.
- A real Canvas OAuth access token is typically **64–128+ characters**.
- **LTI JWT (id_token)** is 500+ chars and must never be used as a Canvas API token.

## What Should Happen

1. **OAuth flow**: After LTI launch, the teacher runs the Canvas OAuth flow (or it runs automatically).
2. **Token exchange**: Code for access token; Canvas returns `access_token` (long string).
3. **Storage**: Store in session (e.g. `session.canvasAccessToken`) keyed by user + Canvas instance.
4. **Usage**: Pass the session or per-course stored Canvas OAuth access token — never a shared env token.

## Fix Applied

1. **Canvas OAuth flow implemented** (`GET /api/oauth/canvas`, `GET /api/oauth/canvas/callback`)
2. **Session storage**: `canvasAccessToken` stored in session after successful OAuth
3. **Token priority**: `session.canvasAccessToken` **first**, then per-course DB token (encrypted); no env fallback
4. **Teacher flow**: Click "Connect Canvas (OAuth)" in Teacher Settings → authorize in Canvas → token stored → course-settings and Canvas API use it

**Configure in Canvas API Key**: Redirect URI = `http://localhost:3000/api/oauth/canvas/callback`
