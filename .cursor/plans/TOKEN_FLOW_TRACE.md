# Token Flow Trace: findAssignmentByTitle → tokenOverride → Source

## Call Chain

1. **`CanvasService.findAssignmentByTitle(courseId, title, domainOverride, tokenOverride)`**
   - `tokenOverride` is the 4th parameter.

2. **Caller: `CourseSettingsService.get()`**
   - Line ~161: `await this.canvas.findAssignmentByTitle(courseId, FLASHCARD_SETTINGS_ASSIGNMENT_TITLE, canvasOverride ?? domainOverride, tokenOverride)`
   - `tokenOverride` comes from line 126: `const tokenOverride = this.config.get<string>('CANVAS_API_TOKEN') ?? null`

3. **Source: `CANVAS_API_TOKEN` from .env**
   - The app uses **only** the env var. There is no OAuth flow implemented.
   - LtiContext has no `canvasApiToken` or `canvasAccessToken`.
   - The OAuth callback route `/oauth/canvas/callback` is documented but **does not exist** in the codebase.

## The Problem

- **69-character token** → Likely wrong value in `CANVAS_API_TOKEN` (e.g. LTI Client ID ≈14 chars, or a truncated/id token).
- A real Canvas OAuth access token is typically **64–128+ characters**.
- **LTI JWT (id_token)** is 500+ chars and must never be used as a Canvas API token.

## What Should Happen

1. **OAuth flow**: After LTI launch, the teacher runs the Canvas OAuth flow (or it runs automatically).
2. **Token exchange**: Code for access token; Canvas returns `access_token` (long string).
3. **Storage**: Store in session (e.g. `session.canvasAccessToken`) keyed by user + Canvas instance.
4. **Usage**: `tokenOverride` should receive this OAuth access token, not `CANVAS_API_TOKEN`.

## Fix Applied

1. **Canvas OAuth flow implemented** (`GET /api/oauth/canvas`, `GET /api/oauth/canvas/callback`)
2. **Session storage**: `canvasAccessToken` stored in session after successful OAuth
3. **Token priority**: `tokenOverride` = `session.canvasAccessToken` (OAuth) **first**, then `CANVAS_API_TOKEN` (env)
4. **Teacher flow**: Click "Connect Canvas (OAuth)" in Teacher Settings → authorize in Canvas → token stored → course-settings and Canvas API use it

**Configure in Canvas API Key**: Redirect URI = `http://localhost:3000/api/oauth/canvas/callback`
