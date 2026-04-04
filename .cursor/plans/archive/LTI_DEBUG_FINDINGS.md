# LTI 1.3 Debug Findings

## Root Cause: API Would Not Start

**The API was failing to compile** due to TypeScript errors in `lti13-launch.service.ts`. No process was listening on port 3000, so any request to `http://localhost:3000` resulted in "localhost refused to connect".

### Fix Applied
- Updated type narrowing in `getPlatformJwksWithError` to use `'error' in jwksResult` instead of `jwksResult.error` so TypeScript correctly narrows the union type.
- `getPlatformJwks` now uses `'jwks' in r` for the same reason.

## LTI 1.3 vs my-canvas-app (LTI 1.1)

| Aspect | my-canvas-app | FlowStateASL |
|--------|---------------|--------------|
| **LTI Version** | LTI 1.1 (Basic LTI) | LTI 1.3 |
| **Config** | `lti-config.xml` (cartridge) | `LTI_1.3_Developer_Key_Canvas_DEV.json` |
| **Launch** | Direct POST to `/lti/launch` with signed form | OIDC login → redirect → Canvas POSTs `id_token` to `/api/lti/launch` |
| **Auth** | OAuth 1.0a signature | JWT (id_token) signed by Canvas |

FlowStateASL uses the standard LTI 1.3 flow; my-canvas-app uses the older LTI 1.1 flow. They are different protocols.

## Deep Linking

FlowStateASL has **link_selection** (LtiDeepLinkingRequest) enabled. When a teacher adds the tool via "External Tool" in a module:

1. Canvas sends `LtiDeepLinkingRequest` to our `/api/lti/launch`
2. **Spec requires**: we return a Deep Linking response (HTML form posting back to Canvas)
3. **Current behavior**: we treat it like Resource Link and redirect to the app

For **course_navigation** (LtiResourceLinkRequest), the current flow is correct. For **link_selection**, we may need to implement proper Deep Linking response handling in the future. This does not cause "localhost refused to connect."

## "localhost refused to connect" – When It Happens

1. **OIDC initiation** – Canvas redirects the user’s browser to `http://localhost:3000/api/lti/oidc/login`. If the API is not running → refused.
2. **Post-launch redirect** – After a successful launch, we redirect to `FRONTEND_URL` (e.g. `http://localhost:4200/flashcards`). If the web app is not running → refused.

Both API (3000) and web (4200) must be running. `npm run start:dev` starts both.

## Canvas in Docker

When Canvas runs in Docker, the user’s browser makes the requests, not the Canvas container. The browser runs on the host, so `localhost:3000` and `localhost:4200` work from the browser.

If Canvas itself must reach your app (e.g. for JWKS), use `host.docker.internal` instead of `localhost` in the Developer Key config. For standard LTI 1.3, Canvas does not fetch from our app; we fetch Canvas’s JWKS to verify the `id_token`.

## LTI 1.3 Course ID vs Canvas API

**`context.id`** in LTI 1.3 is an opaque hash (e.g. `4dde05e8ca1973bcca9bffc13e1548820eee93a3`). The Canvas REST API requires the **numeric course ID** (e.g. `12345`).

**Fix:** The app now prefers `custom.course_id` (from `$Canvas.course.id`) over `context.id` when building the LTI context. Ensure the Developer Key has:

```json
"custom_fields": { "course_id": "$Canvas.course.id", ... }
```

in both root and placement `custom_fields`. Reinstall/update the Developer Key in Canvas if course-settings returns empty arrays and the Bridge log shows `courseIdUsed` as a long hex string.

## Local Canvas: Scheme + Port

The Canvas REST API needs the **full base URL** (scheme + host + port). Local Canvas usually runs on `http://localhost:3001`, not `https://localhost`.

**LTI 1.3:** The app now uses the LTI `iss` (issuer) claim as the Canvas API base URL (e.g. `http://localhost:3001`), preserving scheme and port automatically.

**Fallback:** If not launched via LTI, set `CANVAS_API_BASE_URL=http://localhost:3001` (or your Canvas URL) in `.env`.

## Verification Steps

1. Run `npm run start:dev` – both API and web should start.
2. Visit `http://localhost:3000/api/lti/oidc/login` – expect 400 Bad Request (missing params).
3. Visit `http://localhost:4200` – expect the web app.
4. Use course navigation to launch the tool – avoid link_selection until Deep Linking is implemented.
