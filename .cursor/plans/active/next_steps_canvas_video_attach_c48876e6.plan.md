---
name: next_steps_canvas_video_attach
overview: Analyze current Canvas behavior and define the minimum-risk next implementation steps to restore reliable video attachment without regressing prompt text storage.
todos:
  - id: prerequisite-course-params-and-php-baseline
    content: "PROMINENT TODO (before any new code): update LTI custom parameters in the TJC Canvas course to match FFT, then identify the last historical PHP Prompt Manager revision that truly produced Canvas-attached student videos and use it as the baseline."
    status: pending
  - id: trace-secondary-submit-path
    content: Locate and disable/gate the extra createSubmissionWithBody path targeting assignment 63787613 for prompter submit flow.
    status: pending
  - id: php-payload-parity
    content: Implement strict PHP-equivalent form encoding for attachFileToSubmission payload and headers.
    status: pending
  - id: compare-mode-attach
    content: Add temporary controlled fallback between strict PUT attach and documented online_upload create path, logging compact response deltas only.
    status: pending
  - id: verify-by-fileid
    content: Update verify logic to assert presence of the exact uploaded file id in attachments/history before success.
    status: pending
  - id: single-e2e-proof
    content: Execute one student submission and capture minimal logs that prove text+video ended on the same target student assignment row.
    status: pending
isProject: false
---

# Next Steps: Canvas Prompt + Video Stability

## Prominent Prerequisite TODO

- Before any new coding or retries:
  - Update **TJC Canvas course** custom parameters (they were only updated in FFT).
  - Review **older PHP Prompt Manager revisions** (not just newest `dev2`) and confirm the last version that actually submitted videos successfully to Canvas.

## Current State (from latest run)

- Prompt text storage is restored: `writeSubmissionBody` uses targeted `PUT` and succeeds for student `36849866` on assignment `63789415`.
- Video upload file transfer succeeds (`uploadFileToCanvas OK` with `fileId`), but attach step returns an unchanged submission row (`workflow_state: unsubmitted`, no attachments).
- There is still a separate submission creation call on assignment `63787613` as token-holder user `35402381`; this is likely a parallel/legacy write path and can cause confusion during debugging.

## Most Likely Root Causes

- `attachFileToSubmission` request encoding likely does not match Canvas expectations for `file_ids` on update (accepted request but no effective attach).
- File ownership/context may still not be considered valid for the target submission row at attach time, despite upload success.
- A second prompt-submission path is active (`createSubmissionWithBody` to a different assignment), making verification noisy and masking whether the student target row is the only source of truth.

## Recommended Execution Order

1. **Isolate the authoritative prompt write path** in [apps/api/src/prompt/prompt.service.ts](c:/dev/FlowStateASL/apps/api/src/prompt/prompt.service.ts) and [apps/api/src/canvas/canvas.service.ts](c:/dev/FlowStateASL/apps/api/src/canvas/canvas.service.ts): ensure only the student-row `PUT` path is used for this flow, and identify/remove or gate the `createSubmissionWithBody` call hitting assignment `63787613`.
2. **Normalize attach payload to strict Canvas-compatible form encoding** in [apps/api/src/canvas/canvas.service.ts](c:/dev/FlowStateASL/apps/api/src/canvas/canvas.service.ts), matching PHP semantics exactly for `submission[file_ids]`/array handling (not JSON object serialization ambiguities).
3. **Add one temporary compare-mode attach experiment** (single feature flag) in `attachFileToSubmission`: try the strict PHP payload first; if response shows unchanged row, attempt documented `online_upload` create path and log only compact deltas (submission id/user id/state/type/attachment ids).
4. **Tighten verification criteria and diagnostics** in [apps/api/src/prompt/prompt.service.ts](c:/dev/FlowStateASL/apps/api/src/prompt/prompt.service.ts) to explicitly confirm the uploaded `fileId` appears in either top-level attachments or submission history versions before returning success.
5. **Run one controlled end-to-end submission** and capture only the minimal evidence set: submit write mode, attach request shape, attach response summary, verify summary.

## Success Criteria for Next Session

- Prompt text is stored on assignment `63789415` for student `36849866` (no `as_user_id` errors).
- Video attach response includes either `submission_type: online_upload` or non-empty attachment ids containing the uploaded file id.
- Verification reports attachment evidence within retries and endpoint returns success.
- No extraneous submission creation for assignment `63787613` during the same user submit action.
