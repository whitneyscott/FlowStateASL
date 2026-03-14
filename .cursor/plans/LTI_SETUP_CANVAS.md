# Setting Up ASL Express Flashcards in Canvas LMS

This guide walks you through adding **ASL Express Flashcards** as an LTI 1.1 tool in Canvas. This tool launches the flashcards interface only.

> **Note:** ASL Express Prompter is a separate tool and will be added when it is developed. For now, only Flashcards is available.

## Prerequisites

- Canvas admin access (or permission to add external tools)
- FlowStateASL deployed and reachable (e.g. `https://flowstateasl.onrender.com`)
- The `LTI_1.1_ASL_Express_Flashcards.xml` file in this project

---

## Step 1: Choose Your Canvas Scope

| Scope   | Use case                                             |
|---------|------------------------------------------------------|
| Account | Available to all courses in your institution         |
| Course  | Available only in a specific course                  |

For most setups, add at the **Account** level so teachers can use it across courses.

---

## Step 2: Add the External Tool by URL

1. Log in to Canvas as an admin.
2. Go to **Admin** (wrench icon) → select your **account**.
3. In the left sidebar, go to **Settings** → **Apps** (or **View App Configurations**).
4. Click **+ App** → **+ Add App**.
5. Select **By URL** as the configuration type.
6. **Configuration URL**: Paste one of:
   - `https://raw.githubusercontent.com/whitneyscott/FlowStateASL/main/LTI_1.1_ASL_Express_Flashcards.xml`
   - (Or your own hosted URL if you serve the XML elsewhere.)
7. Click **Submit** or **Add App**.

---

## Step 3: Add the Tool by XML (Alternative)

If your Canvas instance doesn't support configuration by URL:

1. Open `LTI_1.1_ASL_Express_Flashcards.xml` in this project.
2. If you use a custom domain, replace `flowstateasl.onrender.com` with your actual domain in all launch URLs.
3. Go to **Admin** → **Apps** → **+ App**.
4. Select **By XML** as the configuration type.
5. Paste the entire contents of `LTI_1.1_ASL_Express_Flashcards.xml` into the XML configuration field.
6. Click **Submit** or **Add App**.

---

## Step 4: Enable the Tool in a Course

1. Go to the **Course** where you want to use ASL Express Flashcards.
2. Click **Settings** → **Apps** → **View App Configurations** (or **+ App**).
3. Find **ASL Express Flashcards** in the list.
4. Click the **gear icon** (or **Install**) next to it.
5. Enable **Course Navigation** so the link appears in the course sidebar.
6. Save.

---

## Step 5: Test the Launch

1. In the course, click **ASL Express Flashcards** in the left sidebar.
2. You should be redirected to FlowStateASL and see the flashcards interface.

---

## Troubleshooting

### "Missing LTI parameters" or redirect fails
- Confirm `CORS_ORIGIN` and `FRONTEND_URL` in Render match your app URL.
- Ensure the XML launch URLs use `https://` and match your deployed app URL.

### Tool doesn't appear in course
- Add the tool at the Account level first.
- In Course Settings → Apps, ensure **ASL Express Flashcards** is installed and enabled for the course.

### Link shows wrong name
- The tool should appear as **ASL Express Flashcards** in the course nav. If it shows something else, re-add the tool using the XML in this project.

### 401 when saving Teacher Settings (e.g. PUT /api/course-settings)
- The LTI session must be present for API calls. On platforms like Render.com that run **multiple instances**, the default in-memory session store does not persist across instances: the LTI launch may hit instance A (session set) while the next request hits instance B (no session) → 401.
- **Fix:** Add a Redis instance (e.g. Render Redis, Redis Cloud, or Upstash) and set the `REDIS_URL` environment variable. The app uses `connect-redis` to persist sessions across instances. When `REDIS_URL` is set, the session store switches to Redis; when unset, it falls back to in-memory (fine for single-instance/local dev).
- **Check:** In the Bridge Debug Log, a line like `Last API: PUT /api/course-settings → 401 FAILED` confirms this issue. On startup, the server logs `[Session] Using Redis store` when Redis is configured.

---

## Custom Domain

If you use a custom domain instead of `flowstateasl.onrender.com`:

1. Update all URLs in `LTI_1.1_ASL_Express_Flashcards.xml`.
2. Update `CORS_ORIGIN` and `FRONTEND_URL` in Render.
3. Re-add the tool in Canvas (or update the configuration) with the new XML/URL.

---

## Adding ASL Express Prompter Later

When the Prompter tool is developed, a separate XML file will be provided for it. Prompter and Flashcards are distinct LTI tools with different launch URLs and purposes.
