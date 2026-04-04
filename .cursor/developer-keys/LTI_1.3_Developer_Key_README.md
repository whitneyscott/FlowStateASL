# LTI 1.3 Developer Key – Canvas Setup

## File

Use **`LTI_1.3_Developer_Key_Canvas.json`** when creating the LTI 1.3 Developer Key in Canvas.

## Before pasting

1. **Base URL**  
   The JSON uses `https://flowstateasl.onrender.com`. If your app runs elsewhere (e.g. `http://localhost:3000`), do a find‑replace on that base URL in the JSON so that:
   - `oidc_initiation_url`
   - `target_link_uri`
   - `extensions[0].domain`
   - `extensions[0].settings.placements[].target_link_uri`
   - `public_jwk_url`  
   all point to your app.

2. **JWKS endpoint**  
   Canvas will request your public key from `public_jwk_url` (e.g. `https://your-app/api/lti/jwks`). That endpoint must be implemented and return a valid JWK set before LTI 1.3 launches will succeed. If you prefer to paste the key directly in Canvas instead of using a URL, replace `public_jwk_url` with a `public_jwk` object (see Canvas docs).

## Where to paste in Canvas

1. **Admin** (wrench) → **Developer Keys** → **+ Developer Key** → **+ LTI Key**.
2. In the key configuration, choose **Paste JSON** (or **Enter JSON**) and paste the contents of `LTI_1.3_Developer_Key_Canvas.json`.
3. Save and **Enable** the key.
4. **Install the tool**: **Settings** → **Apps** → **View App Configurations** → **+ App** → **By Client ID**. Enter the **Client ID** from the developer key. After installation you’ll see a **Deployment ID** (optional to store in your app for multi‑deployment support).

## What this key configures

- **Course Navigation**: One-click launch (LtiResourceLinkRequest). Tool type (Flashcards vs Prompter) can be determined by your app from Deep Link custom params when the link was added via Link Selection.
- **Link Selection**: Deep Linking (LtiDeepLinkingRequest) so teachers can add “ASL Express” when adding an external tool to a module and choose Flashcards or Prompter.
- **Custom fields**: Course ID, assignment ID, user ID, module ID, and roles are requested so your app receives them in the launch JWT (same as your current LTI 1.1 custom params).
- **Scopes**: AGS (lineitem, score, result) and NRPS (context membership) for possible future use; you can remove scopes you don’t need.

## Two keys (from LESSONS_LEARNED.md)

- **This key** = LTI 1.3 launch only (login, launch, JWKS). Use it for LTI; do not use it for OAuth/API.
- **A separate API Key** = OAuth to get a Canvas API token (e.g. for course settings, assignments). Use `CANVAS_OAUTH_CLIENT_ID` / `CANVAS_OAUTH_CLIENT_SECRET` and turn off “Enforce Scopes” on that key.
