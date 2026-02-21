# Setting Up FlowStateASL as an LTI 1.1 Tool in Canvas LMS

This guide walks you through adding the ASL Express Flashcards and Prompter tools to Canvas via LTI 1.1.

## Prerequisites

- Canvas admin access (or permission to add external tools)
- Your FlowStateASL app deployed and reachable (e.g. `https://flowstateasl.onrender.com`)
- The `LTI_1.1_FlowStateASL.xml` file in this project

---

## Step 1: Choose Your Canvas Scope

You can add the tool at different levels:

| Scope | Use case |
|-------|----------|
| **Account** | Available to all courses in your institution |
| **Course** | Available only in a specific course |

For most setups, add at the **Account** level so teachers can use it across courses.

---

## Step 2: Add the External Tool by URL

1. Log in to Canvas as an admin.
2. Go to **Admin** (wrench icon) → select your **account**.
3. In the left sidebar, click **Developer Keys** (or **Settings** → **Developer Keys** if different).
4. Or go directly: **Settings** → **Apps** → **+ App** (or **View App Configurations** → **+ Add App**).
5. Select **By URL** as the configuration type.
6. **Configuration URL**: You need to provide the XML file URL. Choose one:
   - **Option A (recommended):** Host the XML at a stable URL and paste that URL.
   - **Option B:** Use the raw GitHub URL for `LTI_1.1_FlowStateASL.xml`:
     - `https://raw.githubusercontent.com/whitneyscott/FlowStateASL/main/LTI_1.1_FlowStateASL.xml`
     - (Only works after the file is committed and pushed to GitHub.)
7. Click **Submit** or **Add App**.

---

## Step 3: Add the Tool by XML (Alternative)

If your Canvas instance doesn't support configuration by URL:

1. Open `LTI_1.1_FlowStateASL.xml` in this project.
2. If you use a custom domain, replace `flowstateasl.onrender.com` with your actual domain in all launch URLs.
3. Go to **Admin** → **Apps** → **+ App**.
4. Select **By XML** as the configuration type.
5. Paste the entire contents of `LTI_1.1_FlowStateASL.xml` into the XML configuration field.
6. Click **Submit** or **Add App**.

---

## Step 4: Enable the Tools in a Course

1. Go to the **Course** where you want to use the tools.
2. Click **Settings** → **Apps** → **View App Configurations** (or **+ App**).
3. Find **ASL Express Flashcards** and **ASL Express Prompter** in the list.
4. Click the **gear icon** (or **Install**) next to each tool.
5. Enable **Course Navigation** if you want links in the course sidebar.
6. Save.

---

## Step 5: Use as an Assignment (Prompter only)

To use the Prompter as an **External Tool** assignment (for grades):

1. In a course, go to **Assignments** → **+ Assignment**.
2. Set the submission type to **External Tool**.
3. Click **Find** and select **ASL Express Prompter**.
4. Choose the launch URL: `https://flowstateasl.onrender.com/api/lti/launch/prompter`
5. Check **Load in a new tab** if desired.
6. Save and Publish.

---

## Step 6: Test the Launch

1. **Flashcards (course nav):** Click **Flashcards** in the course sidebar (if enabled).
2. **Prompter (assignment):** Open the assignment and click to launch.
3. You should be redirected to FlowStateASL and see the flashcards or prompter interface.

---

## Troubleshooting

### "Missing LTI parameters" or redirect fails
- Confirm `CORS_ORIGIN` and `FRONTEND_URL` in Render match your Canvas domain if needed.
- Ensure the XML launch URLs use `https://` and match your deployed app URL.

### Tool doesn't appear in course
- Add the tool at the Account level first.
- In Course Settings → Apps, ensure the tool is installed and enabled for the course.

### Grades not passing back
- The assignment must be created as an **External Tool** assignment (not a regular assignment).
- Canvas sends `lis_outcome_service_url` and `lis_result_sourcedid` only in assignment context.
- Ensure `CANVAS_API_TOKEN` and `CANVAS_DOMAIN` are set in Render.

---

## Custom Domain

If you use a custom domain instead of `flowstateasl.onrender.com`:

1. Update all URLs in `LTI_1.1_FlowStateASL.xml`.
2. Update `CORS_ORIGIN` and `FRONTEND_URL` in Render.
3. Re-add the tool in Canvas (or update the configuration) with the new XML/URL.
