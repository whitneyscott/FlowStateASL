---
name: Fully local LTI dev
overview: "Refactor FlowStateASL to use the same fully local setup as Canvas Bulk Editor: Canvas in Docker, app on localhost, no ngrok. Update configs, remove ngrok from startup, and rewrite the walkthrough."
todos: []
isProject: false
---

# Fully Local LTI Development Refactor

Match the Canvas Bulk Editor approach: Canvas runs locally in Docker, app runs locally on localhost. No tunnel, no ngrok.

---

## Changes

### 1. Remove ngrok from startup

In `[package.json](package.json)`, change:

```json
"start:dev:run": "concurrently --kill-others \"nx run-many -t serve --parallel-2\" \"ngrok http 3000\""
```

to:

```json
"start:dev:run": "nx run-many -t serve --parallel=2"
```

(ngrok is no longer needed; remove it from the command.)

---

### 2. Create local Canvas Developer Key JSON

Rename or repurpose `[LTI_1.3_Developer_Key_Canvas_DEV.json](LTI_1.3_Developer_Key_Canvas_DEV.json)` for fully local use. Replace all ngrok URLs with `http://localhost:3000`:

- `oidc_initiation_url`: `http://localhost:3000/api/lti/oidc/login`
- `target_link_uri`: `http://localhost:3000/api/lti/launch`
- `redirect_uris`: `["http://localhost:3000/api/lti/launch"]`
- `public_jwk_url`: `http://localhost:3000/api/lti/jwks`
- `extensions[0].domain`: `localhost` (or `localhost:3000` as needed for deep linking)
- All `target_link_uri` in placements: same base

Note: If Canvas in Docker cannot reach the app via `localhost`, use `host.docker.internal` (Docker Desktop) or your WSL host IP. Canvas Bulk Editor uses localhost; keep that first and document fallbacks.

---

### 3. Update .env.example

In `[.env.example](.env.example)`, set local defaults:

```
APP_URL=http://localhost:3000
LTI_REDIRECT_URI=http://localhost:3000/api/lti/launch
```

Document that for local Canvas dev, `LTI_REDIRECT_URI` must match the Redirect URI in the Canvas Developer Key.

---

### 4. Rewrite LTI_1.3_DEV_SETUP_WALKTHROUGH.md

Rewrite `[LTI_1.3_DEV_SETUP_WALKTHROUGH.md](LTI_1.3_DEV_SETUP_WALKTHROUGH.md)` for fully local setup:

- **Prerequisites**: Canvas running locally in Docker (same setup as Canvas Bulk Editor).
- **Step 1**: Run `npm run start:dev` (app only; no ngrok).
- **Step 2 – LTI Key**: Paste `LTI_1.3_Developer_Key_Canvas_DEV.json`, add Redirect URI `http://localhost:3000/api/lti/launch`.
- **Step 3 – API Key**: Redirect URI `http://localhost:3000/oauth/canvas/callback`.
- **Step 4**: Add tool to course.
- **Step 5**: `.env` with `LTI_REDIRECT_URI`, `APP_URL`, etc.
- **Notes**: If `localhost` doesn’t work for Canvas→app, try `host.docker.internal` or WSL host IP.

---

### 5. Update LESSONS_LEARNED.md

In `[LESSONS_LEARNED.md](LESSONS_LEARNED.md)`:

- Replace ngrok references with the fully local setup.
- Update line 47: "Test LTI tools locally (Canvas and app both local, no tunnel required)".
- Update the Local Dev Startup section: remove ngrok, keep `start:dev` as app-only.

---

### 6. Cleanup

- Remove `ngrok` from `devDependencies` in `package.json` if it exists (grep first).
- Ensure production configs (`[LTI_1.3_Developer_Key_Canvas.json](LTI_1.3_Developer_Key_Canvas.json)`) remain unchanged and use Render URLs.

