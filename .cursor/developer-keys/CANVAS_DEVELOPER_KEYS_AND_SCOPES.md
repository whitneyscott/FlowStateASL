# Canvas developer keys & OAuth scopes (ASL Express / FlowStateASL)

Use this on your **self-hosted Canvas** (or any environment) where you have **admin** access to **Developer Keys**. This is **Canvas configuration**, not Render or your app host.

**LTI 1.1 (e.g. school without admin):** Teachers may use a **manual API token** path; you typically **cannot** add or change developer keys. Prompt Manager features that need **course-scoped OAuth** (files picker, assignment sync, etc.) require a token Canvas is willing to issue—often only fully available under **LTI 1.3 + OAuth**.

---

## Two different “keys” (do not confuse them)

| Piece | What it is | Where you set it |
|--------|------------|------------------|
| **LTI 1.3 Developer Key** | Registers the **tool**: OIDC URL, launch URL, JWKS, **placements**, **custom fields** (`course_id`, `user_id`, …). Those fields control what appears in the **launch JWT**, not REST API access. | Canvas **Admin → Developer Keys → + LTI Key** |
| **OAuth / API Developer Key** | Used when a user clicks **“Connect to Canvas”** (or your app redirects to Canvas OAuth). The returned **access token** calls Canvas **REST APIs** (assignments, modules, **files**, submissions, …). | Often a **separate** key: Canvas **Admin → Developer Keys** (API-style or LTI key that allows OAuth—see your institution’s pattern). Your app expects **`CANVAS_OAUTH_CLIENT_ID`** / **`CANVAS_OAUTH_CLIENT_SECRET`** (see `.env.example`). |

Your repo’s [LTI_1.3_Developer_Key_README.md](./LTI_1.3_Developer_Key_README.md) describes **pasting the LTI JSON** and notes a **separate** key for API OAuth. That separation is common: **one key for LTI launch**, **one for user OAuth to the API**.

You may also have **two LTI client IDs** in env (`LTI_CLIENT_ID` vs `LTI_PROMPTER_CLIENT_ID`) if Flashcards and Prompt Manager use **two LTI keys**—that’s still **LTI launch**, not the OAuth scope list below.

---

## When you must add API scopes

If the **OAuth** developer key has **“Enforce Scopes”** (or equivalent) **enabled**, Canvas will reject API calls unless each endpoint’s scope is allowed on that key.

If scope enforcement is **off**, Canvas may allow broad access (policy-dependent); you still need a valid OAuth client and redirect URI.

**App default:** scopes are sent as the `scope` query parameter during OAuth from code in [`apps/api/src/canvas/canvas-oauth-scopes.ts`](../../apps/api/src/canvas/canvas-oauth-scopes.ts). You can override with env:

- `CANVAS_OAUTH_SCOPES` — space-separated, replaces the default list.
- `CANVAS_OAUTH_SCOPE_MODE=off` — omit sending custom scopes (rely on Canvas key defaults).

**After adding scopes on the key**, users usually need to **authorize again** so the new token includes the new permissions.

Canonical doc: [Canvas API token scopes](https://canvas.instructure.com/doc/api/api_token_scopes.html).

---

## OAuth scope checklist (copy from source of truth)

The list below is the **`DEFAULT_CANVAS_OAUTH_SCOPES`** string split into lines. **When “Enforce Scopes” is on**, ensure your **OAuth** developer key allows **each** of these (or a superset). If Canvas UI groups them differently, match by the **URL pattern** (same path Canvas documents for each scope).

```
url:GET|/api/v1/users/self
url:GET|/api/v1/courses/:course_id/assignment_groups
url:POST|/api/v1/courses/:course_id/assignment_groups
url:GET|/api/v1/courses/:course_id/assignments
url:GET|/api/v1/courses/:course_id/assignments/:id
url:POST|/api/v1/courses/:course_id/assignments
url:PUT|/api/v1/courses/:course_id/assignments/:id
url:GET|/api/v1/courses/:course_id/discussion_topics
url:POST|/api/v1/courses/:course_id/discussion_topics
url:PUT|/api/v1/courses/:course_id/discussion_topics/:topic_id
url:POST|/api/v1/users/self/files
url:POST|/api/v1/courses/:course_id/files
url:GET|/api/v1/courses/:course_id/files
url:GET|/api/v1/courses/:course_id/folders/root
url:GET|/api/v1/folders/:folder_id
url:GET|/api/v1/folders/:folder_id/folders
url:GET|/api/v1/folders/:folder_id/files
url:GET|/api/v1/files/:id
url:GET|/api/v1/courses/:course_id/assignments/:assignment_id/submissions
url:POST|/api/v1/courses/:course_id/assignments/:assignment_id/submissions
url:PUT|/api/v1/courses/:course_id/assignments/:assignment_id/submissions/:user_id
url:GET|/api/v1/courses/:course_id/rubrics
url:PUT|/api/v1/courses/:course_id/rubrics/:id
url:POST|/api/v1/courses/:course_id/rubric_associations
url:GET|/api/v1/courses/:course_id/modules
url:POST|/api/v1/courses/:course_id/modules
url:PUT|/api/v1/courses/:course_id/modules/:id
url:GET|/api/v1/courses/:course_id/modules/:module_id/items
url:POST|/api/v1/courses/:course_id/modules/:module_id/items
url:GET|/api/v1/courses/:course_id/external_tools
url:GET|/api/v1/courses/:course_id/external_tools/:external_tool_id
url:GET|/api/v1/courses/:course_id/external_tools/sessionless_launch
url:GET|/api/v1/courses/:course_id/lti_resource_links
url:GET|/api/v1/courses/:course_id/quizzes
url:POST|/api/v1/courses/:course_id/quizzes
```

### Recently added (prompt images + file explorer)

If you configured the key **before** course file upload/browse work, confirm these are on the **OAuth** key:

- `url:POST|/api/v1/courses/:course_id/files` — upload image into course Files  
- `url:GET|/api/v1/courses/:course_id/files` — list course files  
- `url:GET|/api/v1/courses/:course_id/folders/root` — resolve course Files root  
- `url:GET|/api/v1/folders/:folder_id` — folder metadata (explorer)  
- `url:GET|/api/v1/folders/:folder_id/folders` — subfolders (explorer)  
- `url:GET|/api/v1/folders/:folder_id/files` — files in folder (explorer)  
- `url:GET|/api/v1/files/:id` — file metadata + proxy display  

---

## LTI custom fields (not the same as API scopes)

On the **LTI** developer key / tool placements, **custom fields** (e.g. `course_id` → `$Canvas.course.id`) only affect **launch claims**. They do **not** replace adding **API scopes** on the **OAuth** key for Files, Assignments, etc.

---

## Quick setup order (home Canvas)

1. Create or update **LTI 1.3** key from JSON (see [LTI_1.3_Developer_Key_README.md](./LTI_1.3_Developer_Key_README.md) and `LTI_1.3_Developer_Key_Canvas*.json`).  
2. Create or update **OAuth** developer key; set redirect URI to match **`CANVAS_OAUTH_REDIRECT_URI`** in your app.  
3. If enforcing scopes, add every line in the checklist above to that **OAuth** key.  
4. Install the LTI tool **By Client ID** in the account/course.  
5. In your app `.env`, set `CANVAS_OAUTH_CLIENT_ID` / `SECRET` (and `LTI_CLIENT_ID` / `LTI_PROMPTER_CLIENT_ID` as you use today).  
6. Re-launch the tool and complete **Canvas OAuth** once as a teacher to refresh the token after scope changes.

---

## Source of truth in code

If this document drifts, the authoritative default scope string is:

`apps/api/src/canvas/canvas-oauth-scopes.ts` → `DEFAULT_CANVAS_OAUTH_SCOPES`.
