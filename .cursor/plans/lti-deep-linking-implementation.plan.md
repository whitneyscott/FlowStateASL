# LTI 1.3 Deep Linking – homework_submission Implementation Plan

## Part 0: Stable checkpoint (run in Agent mode)

Plan mode cannot run git. To create the checkpoint:

1. **Stage all changes:** `git add -A`
2. **Commit:** `git commit -m "LTI 1.3 shared helpers complete - stable checkpoint before Deep Linking implementation"`
3. **Push:** `git push origin <branch>` (e.g. `main`)
4. **Confirm:** Check GitHub for the commit and green CI if applicable.

---

## 1. Developer Key changes

**File:** [LTI_1.3_Developer_Key_Canvas_DEV_PROMPTER.json](LTI_1.3_Developer_Key_Canvas_DEV_PROMPTER.json) (and any prod key JSON you maintain)

Add a **homework_submission** placement alongside existing `course_navigation` and `link_selection`:

- **placement:** `"homework_submission"`
- **message_type:** `"LtiDeepLinkingRequest"` (Canvas sends Deep Linking request; tool returns content item)
- **target_link_uri:** same as other placements (e.g. `http://localhost:3000/api/lti/launch`)
- **selection_width** / **selection_height:** set so the recording UI fits in the iframe (e.g. `1024` and `768`, or `1200` and `800`). Canvas may enforce min/max; document recommended values in a comment or README.
- **custom_fields:** same as other placements (`course_id`, `assignment_id`, `user_id`, `module_id`, `roles`, `tool_type`: `prompter`)
- **text** (and optionally **icon_url**): label for the tab in the file upload UI (e.g. "ASL Express – Record video")

After editing the JSON, re-import or paste into the Canvas Developer Key (or create a new key) and install the tool on the account/course. Assignments must use **Online** submission type **File Upload** for the homework_submission tab to appear.

---

## 2. Deep Linking launch flow (end to end)

- **Same launch URL:** Canvas still uses the single LTI 1.3 launch URL; the **message_type** in the JWT distinguishes Resource Link vs Deep Linking.
- **Iframe stays open:** Student sees prompts and records inside the tool; only after the tool posts the Deep Linking response does Canvas close/update the iframe and attach the file.
- (Full sequence diagram and steps 3–7 unchanged: receive request, extract deep_link_return_url, host video for Canvas GET, post content item JWT, Canvas downloads and attaches file.)

---

## 3–7. (Unchanged)

Sections 3–7 of the original plan remain: tool receives Deep Linking request and `deep_link_return_url`; video hosted via one-time token (or signed URL); tool posts LtiDeepLinkingResponse JWT via form POST; Canvas GETs file and attaches to submission; frontend branches on `messageType === 'LtiDeepLinkingRequest'` and uses new submit-deep-link path.

---

## 8. Risks and Canvas-specific quirks

- (Existing bullets: iframe size, same launch URL, deep_link_return_url usage, file URL accessibility, echo `data`, JWT lifetime, assignment type.)
- **Grading:** Canvas docs note that tools using homework_submission cannot use LTI grading services to sync grades for that placement. **Resolution:** Use a **shadow assignment** (see section 10); grades are submitted to the shadow assignment via AGS; the visible assignment holds the video (from Deep Linking), the shadow holds the gradebook column.

---

## 9. Implementation order (suggested)

1. Developer Key: add homework_submission placement; test that the tab appears on a File Upload assignment.
2. Backend: extend `LtiContext` and `payloadToContext` to detect `LtiDeepLinkingRequest` and set `deepLinkReturnUrl` and `deepLinkData`.
3. Backend: implement one-time file URL (e.g. `/api/lti/deep-link-file/:token`) and storage/cleanup.
4. Backend: implement Deep Linking response builder (JWT payload + sign with LTI key) and HTML form renderer; add `POST /api/prompt/submit-deep-link` (or branch in existing submit).
5. Frontend: when context is Deep Linking, call the new submit path and render the returned HTML so the form auto-posts to Canvas.
6. E2E: launch from assignment, record, submit, confirm file appears in Canvas submission.
7. Shadow assignment and grading (section 10): config storage, submission detection, teacher UI, grade submission to shadow.

---

## 10. Shadow assignment and grading

To resolve the grading limitation (homework_submission placement cannot use LTI grading services to push grades into the same assignment), we use a **shadow assignment** and mirror the approach from the PHP Prompt Manager, with the video stored on the **visible** assignment (via Deep Linking) and grading done via the **shadow** assignment.

### 10.1 Concept

- **Visible assignment:** The one the teacher configures and students see. Submission type: File Upload. Students submit via Deep Linking; Canvas attaches the video file here.
- **Shadow assignment:** A separate assignment in the same course, created and managed by the app. Its **assignment ID is stored with the prompt manager settings** the teacher configured for the (visible) assignment. Grades are submitted to this shadow assignment via LTI AGS so they appear in the Canvas gradebook.
- **Flow:** App detects when the visible assignment has new submissions; shows submission count in the teacher's settings tool; teacher clicks a button to open submitted videos (from the visible assignment's submissions) and submits grades into the shadow assignment (e.g. via AGS or Canvas API). Same idea as the PHP prompt manager, with video on the visible assignment and grades on the shadow.

### 10.2 Data model and config

- **Prompt manager settings** (already stored in Canvas assignment description or course-level config) must include **shadow assignment ID** for the assignment the teacher is configuring. The codebase already has `shadowAssignmentId` in [apps/api/src/prompt/dto/prompt-config.dto.ts](apps/api/src/prompt/dto/prompt-config.dto.ts) (get/put config).
- **Ensure shadow assignment exists:** When the teacher saves settings (or on first load for grading), the app should ensure a shadow assignment exists in the course (e.g. create via Canvas API if missing), store its ID in config, and optionally hide it from the student view or name it clearly (e.g. "Prompt Manager – Grades").

### 10.3 Detecting submissions and showing count

- **Backend:** Add an endpoint or extend existing config/submissions API to return **submission count for the visible assignment** (the one in LTI context / assignment_id). Use Canvas API: list submissions for the visible assignment (course and assignment IDs from context). Count submissions that have at least one attachment (the Deep Linking video).
- **Teacher settings UI:** In the teacher's settings tool (e.g. [TeacherConfigPage](apps/web/src/pages/TeacherConfigPage.tsx) or viewer), display the number of submissions for the current assignment (e.g. "3 submissions"). Data can come from existing `getSubmissions`-style endpoint or a dedicated "submission count" or "grading summary" endpoint that uses the visible assignment ID from config.

### 10.4 Teacher opens videos and submits grades to shadow

- **Button in teacher UI:** e.g. "Open submissions to grade" or "Grade submissions." Click opens the list of submitted videos (from the **visible** assignment's submissions – use Canvas submission attachment URLs or your own copy if you store them).
- **Viewing videos:** Teacher watches each submission (same as current viewer flow if you already have one; otherwise a simple list with links to Canvas file URLs or tool-hosted playback).
- **Submitting grade:** For each student, teacher enters a score (and optional rubric/comment). The app **submits the grade to the shadow assignment** via LTI AGS (create/update score for the shadow assignment's line item), not to the visible assignment. This requires:
  - **AGS for shadow:** The shadow assignment must be associated with an LTI resource link (or the tool must have a line item for "this course + shadow assignment") so AGS can push the grade. Options: (a) create the shadow assignment as an LTI (External Tool) assignment that launches the same tool with a custom param indicating "grading only"; or (b) use Canvas API to create/update a grade for the shadow assignment by user ID (if Canvas allows grading an assignment without an LTI link). Prefer the approach that matches the PHP prompt manager (likely AGS on a shadow LTI link or Canvas grade update API for the shadow assignment).
- **Result:** Students see the video on the visible assignment; the gradebook column that counts for the course grade is the shadow assignment, so teachers use the tool to push grades there.

### 10.5 Implementation notes

- **Line item for shadow:** If using AGS, ensure a line item exists for the shadow assignment context (e.g. create on first "grade" action or when creating the shadow assignment). [LtiAgsService](apps/api/src/lti/lti-ags.service.ts) and Canvas AGS docs: line items are tied to a resource link; the shadow assignment may need to be an LTI assignment so it has a resource_link_id and line item.
- **Mapping student to submission:** Use Canvas user ID (from submission or LTI context) to match "this submission" to "this grade for shadow assignment."
- **UX:** Keep the flow similar to the PHP prompt manager: one place in the teacher tool to see submission count, one action to open the grading view, and one action per student (or batch) to submit grade to the shadow assignment.

---

No code changes are made until you approve this plan; the checkpoint commit/push should be run in Agent mode.
