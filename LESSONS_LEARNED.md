# Lessons Learned

## Two Developer Keys Required (Critical)

You need **two** separate Developer Keys in Canvas:

| Key Type | Purpose | .env Variables | Scope Enforcement |
|----------|---------|----------------|-------------------|
| **LTI Key** | LTI 1.3 launch (login, launch, JWKS) | `LTI_CLIENT_ID` | Enforced—causes `invalid_scope` if used for OAuth |
| **API Key** | OAuth to get Canvas API token | `CANVAS_OAUTH_CLIENT_ID`, `CANVAS_OAUTH_CLIENT_SECRET` | Off by default—required for OAuth flow |

Create the **API Key** via Admin → Developer Keys → Add Developer Key → **Add API Key** (not LTI Key). Turn off "Enforce Scopes" on the API key. Add redirect URI `{APP_URL}/oauth/canvas/callback`. Put its Client ID and Secret in `.env`.

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
  2. OAuth callback: `{APP_URL}/oauth/canvas/callback`
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

## Debug Log

- Available at `/lti/debug`. Shows login, launch, and OAuth steps.
- Shareable URL lets others (or tools) inspect it directly instead of copying logs—saves time and reduces mistakes.
