# LTI 1.3 Developer Key – Fully Local Dev Setup

You need **two separate Developer Keys** in Canvas: (1) an **LTI Key** for launch, (2) an **API Key** for OAuth (Canvas API calls). Both Canvas and the app run locally—no tunnel required. Same approach as Canvas Bulk Editor.

---

## Prerequisites

- **Canvas** running locally in Docker (same setup as Canvas Bulk Editor)
- **FlowStateASL** app runs on `http://localhost:3000`

---

## Step 1: Start the app

Run:

```
npm run start:dev
```

This starts the API and web app only. No ngrok.

---

## Step 2: Key 1 – LTI Key (launch)

1. Open **`LTI_1.3_Developer_Key_Canvas_DEV.json`** (already configured for `http://localhost:3000`).
2. Canvas **Admin** → **Developer Keys** → **+ Developer Key** → **+ LTI Key**.
3. Paste the JSON. **Critical:** Add this exact **Redirect URI** in the Developer Key form (separate field, not in the JSON): `http://localhost:3000/api/lti/launch` — Canvas will reject the launch with "Invalid redirect_uri" if this does not match exactly.
4. Save and **Enable** the key.
5. Copy the **Client ID** → put in `.env` as `LTI_CLIENT_ID`.

### Deploy the LTI tool

6. **Admin** → **Settings** (or **Apps**) → **+ App** → **Install by Client ID**.
7. Paste the same **Client ID** (from step 5). Submit. Note the **Deployment ID** if shown.

---

## Step 3: Key 2 – API Key (OAuth for Canvas API)

The app uses OAuth to call Canvas API (course settings, assignments). This is a **different** key from the LTI Key.

1. Canvas **Admin** → **Developer Keys** → **+ Developer Key** → **Add API Key** (not LTI Key).
2. Turn **off** "Enforce Scopes".
3. Add **Redirect URI**: `http://localhost:3000/oauth/canvas/callback`
4. Save and **Enable**.
5. Copy **Client ID** and **Client Secret** → add to `.env`:

```
CANVAS_OAUTH_CLIENT_ID=<paste Client ID>
CANVAS_OAUTH_CLIENT_SECRET=<paste Client Secret>
```

---

## Step 4: Add the tool to a course

1. Open a **course** → **Settings** → **Apps** (or **+ App**).
2. Find **ASL Express (Dev)** and enable **Course Navigation**.
3. Save.

---

## Step 5: .env summary

Your `.env` should have:

```
APP_URL=http://localhost:3000
LTI_CLIENT_ID=<Client ID from LTI Key>
LTI_REDIRECT_URI=http://localhost:3000/api/lti/launch
CANVAS_OAUTH_CLIENT_ID=<Client ID from API Key>
CANVAS_OAUTH_CLIENT_SECRET=<Client Secret from API Key>
```

`LTI_REDIRECT_URI` must match the Redirect URI you added to the LTI Developer Key. Restart the API after changing `.env`.

---

## Notes

- **LTI Key** = launch only. **API Key** = OAuth for Canvas API. Do not use the LTI Key for OAuth (it will fail with invalid_scope).
- **If `localhost` doesn't work** (e.g. Canvas in Docker can't reach the app): try `host.docker.internal` (Docker Desktop) or your WSL host IP (`hostname -I`) instead of `localhost` in the JSON and Developer Key redirect URIs.
- **CORS / FRONTEND_URL**: Use `http://localhost:4200` for local dev.
