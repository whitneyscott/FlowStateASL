# Setting Up the Prompt Manager (Prompter) App in Canvas (LTI 1.3)

**Location:** This file and the JSON configs below live in the **project root** (same folder as `package.json`).

The app supports two tools over the same LTI 1.3 launch URL: **Flashcards** (default) and **Prompter** (Prompt Manager). Canvas tells the app which tool to open by sending a custom parameter `tool_type`. You already have the **Flashcards** app configured (one Developer Key). To add **Prompt Manager** as a separate link in the course, add a **second** LTI 1.3 Developer Key that sends `tool_type=prompter`.

---

## JSON files to paste (project root)

| File | Use when |
|------|----------|
| **`LTI_1.3_Developer_Key_Canvas_DEV_PROMPTER.json`** | Canvas and app run locally (e.g. `http://localhost:3000`). |
| **`LTI_1.3_Developer_Key_Canvas_PROMPTER.json`** | Production (e.g. `https://flowstateasl.onrender.com`). |

Each file already has **title**, **description**, and **custom_fields.tool_type = "prompter"** set. If your base URL differs, do a find-replace on the URL in the JSON before pasting.

---

## Prerequisites

- You already have the **ASL Express** (Flashcards) LTI 1.3 Developer Key set up and installed in Canvas.
- Same base URL and JWKS as the Flashcards key (same API and launch URL).

---

## Developer Key configuration to verify

For both Flashcards and Prompter keys, ensure these are set in the Developer Key:

### Custom fields (variable substitution)

Add or verify these **custom fields** — exact syntax, no quotes, case-sensitive:

| Name         | Value                     |
|--------------|---------------------------|
| `module_id`  | `$Canvas.module.id`       |
| `assignment_id` | `$Canvas.assignment.id` |

Canvas substitutes these when the tool is launched from a module/assignment. If you see raw strings like `$Canvas.module.id` in the app, the custom field was entered incorrectly (e.g. with quotes or different casing).

### AGS (LTI Advantage Services) — required for grade passback

In the Developer Key, go to **LTI Advantage Services** and enable:

- Can create and view assignment data in the gradebook
- Can view submission data for assignments
- Can create and update submission results for assignments

Without these, grade passback (Steps 11a–11d of the LTI plan) will not work.

---

## Option A: Second Developer Key (recommended)

This gives you two entries in the course: one that opens Flashcards, one that opens Prompt Manager.

### 1. Create a second LTI 1.3 Developer Key

1. In Canvas, go to **Admin** (wrench) → **Developer Keys** → **+ Developer Key** → **+ LTI Key**.
2. Choose **Paste JSON** (or **Enter JSON**).
3. Paste the **entire contents** of one of the JSON files from the project root:
   - **Local dev:** open **`LTI_1.3_Developer_Key_Canvas_DEV_PROMPTER.json`** and paste.
   - **Production:** open **`LTI_1.3_Developer_Key_Canvas_PROMPTER.json`** and paste. If your app URL is not `https://flowstateasl.onrender.com`, find-replace that base URL in the JSON first.
4. In the key form, set **Redirect URI** to match your launch URL:
   - Local: `http://localhost:3000/api/lti/launch`
   - Production: `https://flowstateasl.onrender.com/api/lti/launch`  
   It must match **exactly**.
5. **Save** and **Enable** the key.
6. Copy the **Client ID** of this new key (you do **not** need to put it in `.env`; the app uses the Client ID from the launch request).

### 2. Install the Prompt Manager tool in Canvas

1. **Admin** → **Settings** → **Apps** (or **View App Configurations**) → **+ App** → **By Client ID**.
2. Paste the **Client ID** of the **Prompt Manager** key you just created.
3. Submit. The app will appear as a second LTI tool (e.g. **ASL Express – Prompt Manager**).

### 3. Add the tool to the course

1. Open the **course** where you want Prompt Manager.
2. **Settings** → **Apps** (or **+ App** / **View App Configurations**).
3. Find the **Prompt Manager** app (the one you installed by the second Client ID).
4. Click the gear (or **Install**) and enable **Course Navigation** (or the placement you use).
5. Save.

### 4. Test

1. In the course sidebar (or wherever the placement appears), click the **Prompt Manager** link.
2. Canvas runs the LTI 1.3 flow; the app receives `custom.tool_type === 'prompter'` and redirects to **/prompter**.
3. You should land on the Prompter UI (e.g. `FRONTEND_URL/prompter?lti_token=...`). In the Bridge Debug Log you should see **Tool: prompter** and **Redirect path (Step 2): /prompter**.

---

## Option B: One key, Link Selection (Deep Linking) – future

With one Developer Key, teachers can use **Link Selection** (Deep Linking) when adding an external tool to a module: the app would offer “Flashcards” and “Prompter” and return two resource links. Links created as “Prompter” would send `tool_type=prompter` when launched. That requires the app to implement the Deep Link **response** (returning LtiResourceLink items with custom `tool_type`). Until that is implemented, use **Option A** (second key) to set up the Prompt Manager app in Canvas.

---

## Summary

| Goal                         | What to do                                                                 |
|-----------------------------|----------------------------------------------------------------------------|
| Flashcards in course       | Use your existing LTI 1.3 key (no `tool_type` or `tool_type=flashcards`).  |
| Prompt Manager in course   | Add a **second** LTI 1.3 key with **custom_fields.tool_type = "prompter"**, install by Client ID, then enable it in the course. |
| Same app, same launch URL  | Both keys use the same **target_link_uri** and **public_jwk_url**; only the custom param differs. |

If the Prompter link still opens Flashcards, the launch JWT is not including `tool_type: 'prompter'`. Confirm the second key’s **custom_fields** (and placement custom_fields if used) include **"tool_type": "prompter"** and that you’re launching from the app that was installed with that key’s Client ID.
