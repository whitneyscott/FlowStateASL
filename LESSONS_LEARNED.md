# Lessons Learned

## Two Developer Keys Required (Critical)

You need **two** separate Developer Keys in Canvas:

| Key Type | Purpose | .env Variables | Scope Enforcement |
|----------|---------|----------------|-------------------|
| **LTI Key** | LTI 1.3 launch (login, launch, JWKS) | `LTI_CLIENT_ID` | Enforced—causes `invalid_scope` if used for OAuth |
| **API Key** | OAuth to get Canvas API token | `CANVAS_OAUTH_CLIENT_ID`, `CANVAS_OAUTH_CLIENT_SECRET` | Off by default—required for OAuth flow |

Create the **API Key** via Admin → Developer Keys → Add Developer Key → **Add API Key** (not LTI Key). Turn off "Enforce Scopes" on the API key. Add redirect URI `{APP_URL}/api/oauth/canvas/callback`. Put its Client ID and Secret in `.env`.

After changing `.env`, **restart the NestJS server** (not Canvas). The app loads env at startup.

## Canvas Setup

- Use a stable branch (`git checkout stable/YYYY-MM-DD`), not master.
- Run `sudo chmod -R 777 ~/canvas` before setup to prevent permission errors.
- Canvas must be on the Linux filesystem (`~/canvas`), never on `/mnt/c/`.
- Add `ports: - "80:80"` to the web service in `docker-compose.override.yml` or the browser can't reach Canvas.

## LTI 1.3 Developer Key

- `scopes` must be an array `[]`, not an empty string `""`.
- Client ID (e.g. `10000000000003`) is the Developer Key ID—it never changes.
- Installing "By Client ID" creates a new deployment; that's normal.
- Don't hardcode `client_id` validation in the app—Canvas generates new IDs per installation.
- Two redirect URIs are required:
  1. LTI launch: `{APP_URL}/api/lti/launch`
  2. OAuth callback: `{APP_URL}/api/oauth/canvas/callback`
- See "Two Developer Keys Required" above—LTI Key for launch, API Key for OAuth.

## LTI 1.3 Endpoints and Flow

- **GET /api/lti/oidc/login** — OIDC initiation. Canvas redirects here with `iss`, `login_hint`, `target_link_uri`, etc. App stores state/nonce, redirects to Canvas auth.
- **POST /api/lti/launch** — Canvas POSTs `id_token` and `state` here. App validates JWT (using platform JWKS at `{iss}/api/lti/security/jwks`), extracts context, creates session, redirects to flashcards or prompter.
- **GET /api/lti/jwks** — Returns tool's public key in JWK format. Canvas fetches this for client_credentials and verification.
- **Required .env**: `LTI_CLIENT_ID`, `LTI_REDIRECT_URI` (must match the redirect URI in the LTI Developer Key, e.g. `http://localhost:3000/api/lti/launch` for local dev).
- **Optional .env**: `LTI_PRIVATE_KEY` — PEM for JWT signing. If unset, a key is auto-generated at startup (dev only; set in production).

## LTI 1.3 Architecture

- Keep Canvas and the app in the same environment—both local or both deployed. Mixing them causes the app to fetch unreachable URLs (e.g. Render trying to hit `http://localhost`).
- `iss` comes from Canvas's configured domain; the app fetches platform JWKS from `{iss}/api/lti/security/jwks`.
- Deployment ID is dynamic—never hardcode it.
- Test LTI tools locally first (Canvas and app both local—no tunnel required), then migrate URLs to production.


## DO NOT use ngrok for Local LTI Dev

ngrok adds several layers of friction that you don't have with fully local development:

- **URL changes every restart (free tier)** — You must update Canvas Developer Keys and `.env` every session.
- **ngrok inspect header/interstitial** — Canvas sometimes gets an ngrok "Visit Site" page instead of your app, breaking the launch flow.
- **Two URLs to keep in sync** — ngrok URL in Canvas AND in `.env`; a mismatch causes "Invalid redirect_uri".
- **CORS issues** — Your app may reject requests from the ngrok domain.

**Instead:** Run Canvas and the app both locally. Canvas in Docker, app on localhost. Use `http://localhost:3000` (or `host.docker.internal` / WSL IP if needed) in the Developer Key and `.env`. Same setup as Canvas Bulk Editor—no tunnel required.

## Local Dev Startup

- **Kill processes on needed ports before starting** to avoid `EADDRINUSE`. Options:
  - `npx kill-port 3000 4200 9229` (cross-platform)
  - `lsof -ti:3000 | xargs kill` (Unix/macOS)
- **Start services sequentially**, not simultaneously, so ports are free before the next service binds.
- **Use a single startup command** that handles cleanup + ordered startup. Ask Cursor to create/maintain an npm script for this (e.g. `npm run dev:clean` or `npm run start:dev`). The script should: (1) kill ports, (2) then start the app. Do not use ngrok.

## APP_URL

- Project configured for localhost: `http://localhost:3000`. Production: `https://canvas-bulk-editor.onrender.com`.

## Debug Log / Bridge Debug Log

- **Bridge Debug Log** appears on flashcards and prompter pages. Add `?debug=1` to the URL (e.g. `/flashcards?debug=1`) to force it expanded and scrolled into view.
- The **LTI Launch Log** section shows OIDC and launch steps from the backend. If LTI errors occur, the API error page links to `/flashcards?debug=1`.
- Last 500 errors and LTI log entries are polled from `/api/debug/last-error` and `/api/debug/lti-log`.

## "localhost refused to connect"

- **Cause**: No process listening on the requested port. Most often the **API failed to start** (e.g. TypeScript build errors in `lti13-launch.service.ts`).
- **Check**: Ensure `npm run start:dev` starts both API (3000) and web (4200) without build errors. If API build fails, fix the errors before launching.

## LTI 1.3 vs LTI 1.1 (my-canvas-app)

- **my-canvas-app** uses **LTI 1.1**: direct POST to `/lti/launch` with signed form params. Config: `lti-config.xml` (cartridge).
- **FlowStateASL** uses **LTI 1.3**: OIDC login → redirect → Canvas POSTs `id_token` to `/api/lti/launch`. Config: `LTI_1.3_Developer_Key_Canvas_DEV.json`.
- They are different protocols; do not expect the same launch flow.

## LTI 1.3 Placeholder Values

- When launching from **course navigation** (sidebar), Canvas may not substitute `$Canvas.module.id` and `$Canvas.assignment.id`—they appear as literal strings. This is expected; those values are only populated when launching from within a module item or assignment.
- Launch from course navigation for initial testing; use module/assignment links when you need real module/assignment IDs.

## LTI 1.3: client_id Fallback

- Canvas does not always send `client_id` in the OIDC initiation request. The app falls back to `LTI_CLIENT_ID` from `.env`. Ensure `.env` has the correct Client ID from your LTI Developer Key.

## LTI 1.3: RS256 Key Size (2048 Bits)

- **Error**: `JWT verification failed: RS256 requires key modulusLength to be 2048 bits or larger`
- **Cause**: Canvas Docker/local dev may use 1024-bit RSA keys for LTI signing. The `jose` library enforces a 2048-bit minimum for RS256.
- **Fix**: Dev-only workaround in `lti13-launch.service.ts`—on this error and `NODE_ENV !== 'production'`, fall back to `jsonwebtoken` with `allowInsecureKeySizes: true`. Production Canvas (Instructure cloud) uses 2048+ bit keys; Render deployment is unaffected.
- Same issue seen in my-canvas-app.

## LTI 1.3: Deep Linking

- The Developer Key includes **link_selection** (LtiDeepLinkingRequest) and **course_navigation** (LtiResourceLinkRequest). Both use the same `target_link_uri`.
- **course_navigation** works out of the box—launch from the sidebar, redirect to flashcards/prompter.
- **link_selection** (adding tool from module "External Tool" picker) may require a dedicated Deep Linking response handler in the future. For now, prefer course navigation for launch.

## Canvas Submissions API and User ID

- **Canvas OAuth tokens are typically 64 characters** — this is normal. Do not assume truncation.
- **LTI `$Canvas.user.id` may not be substituted** — In some launch contexts (e.g. course navigation), custom field `$Canvas.user.id` can arrive as null or the literal string. Do not rely on `ctx.canvasUserId` for Canvas API calls.
- **Submissions write uses token owner** — `POST /api/v1/courses/:id/assignments/:id/submissions` (no user ID in path) creates/updates the submission for the authenticated user. This works correctly for student self-submit.
- **Submissions GET requires numeric Canvas user ID** — `GET /api/v1/.../submissions/:user_id` expects the Canvas numeric ID. LTI `sub` (opaque UUID) is not recognized. **Fix**: resolve the ID from the token via `GET /api/v1/users/self`; use the returned `id` for the submissions GET. See `CanvasService.getCurrentCanvasUserId()` and `saveProgressToCanvas` verification.
