---
name: Pre-coach product hardening
overview: "UI/curriculum/debt work before heavy Language Coach implementation. Top priority: course copy survival for LTI 1.1 and 1.3. Also: student Deliberate Practice (comparison + stated goals). Distinct from YouTube-chat side-by-side (different product context)."
todos:
  - id: course-copy-survival-lti
    content: "Harden course copy survival for BOTH LTI 1.1 and 1.3. LTI 1.1 is notorious for breaking on copy; 1.3 is better but not a reason to drop 1.1—teachers who lack admin to deploy 1.3 need a reliable 1.1 path. Audit/fix resource links, placement ID remapping, course-level blob, assignment embeds, and first-launch recovery in copied courses."
    status: pending
  - id: student-compare-previous-attempt
    content: "Student recording session: side-by-side comparison of current submission vs any previous attempt on same assignment (post-session + return-to-review). Primary growth-evidence for trajectory."
    status: pending
  - id: student-compare-language-model
    content: "Formalize side-by-side vs expert/language model (SOAR Sprout reference, Watch and Sign stimulus where applicable). Aspirational fluent target; build on existing partial SOAR reference behavior."
    status: pending
  - id: goal-setting-ui-persistence
    content: "After recording, before submit: prompt 'What are you working on next time?' (one text field). Persist { studentId, assignmentId, attemptNumber, statedGoal, createdAt }. On later sessions, show 'Last time you were working on: [goal]' before record."
    status: pending
isProject: true
---

**Canonical path:** `.cursor/plans/active/pre-coach-product-hardening.plan.md`

# Pre-coach product hardening

See [flowstateasl-grand-vision.md](../flowstateasl-grand-vision.md) for full product vision. This plan covers work **before** the Language Coach engine, including Deliberate Practice features that **do not** require coach infrastructure.

## Course copy survival (LTI 1.1 and 1.3) — top priority

**Problem:** Instructors copy Canvas courses to reuse a term or a colleague’s structure. **LTI 1.1** is notorious for **not surviving** course copy cleanly (stale or broken tool placements, client IDs, resource associations). **LTI 1.3** generally behaves better, but the product should **not** assume all deployments can rely on 1.3: **individual teachers** may use the tool without **admin** privileges to install or favor **LTI 1.1**; both launch paths need to be **first-class** for long-term course reuse.

**Goal:** Harden **import / copy / first-open** behavior so that **both** 1.1 and 1.3 deployments remain usable in a **copied** course: assignments, embedded config (`data-asl-express` blocks), course-level LTI index blob, and any placement-to-assignment mapping remain recoverable or repairable (clear errors, re-link flows, or documented operator steps) without silent data loss.

**Scope (planning, not an implementation checklist here):** Align with existing work in the import and Canvas-bridge area; validate behavior when Canvas issues **new assignment IDs** and when **resource link** / **context** ids change. Prefer explicit detection of “this course was copied” or “this placement is orphan” over opaque failures.

**Rationale for ordering:** A broken copy path wastes teacher time and undermines every other feature; fix reliability before piling on UI or coach work.

---

## Context: comparison vs other surfaces

Side-by-side **YouTube** playback (e.g. chat) is a **different context** and is not the Deliberate Practice student comparison story documented here. This document is the canonical place for **student** comparison modes in the **recording/assignment** flow.

---

## Student Video Comparison (Deliberate Practice)

The student-facing recording experience should support **side-by-side video comparison** as a core Deliberate Practice tool.

### 1. Compare to previous attempt

- After completing a recording session, or when returning to review, the student can view their **current** submission **side-by-side** with **any previous attempt** on the **same assignment**.
- This is the **primary growth-evidence** mechanism: students see their own **trajectory** across attempts.
- Pedagogically, comparing to one’s own past self is **more motivating** than an expert model alone, because the past self is *beatable*.
- **Does not** require Language Coach infrastructure — build as part of this (pre-coach) track.

### 2. Compare to language model

- Side-by-side: student submission **vs** the **expert / language model** video for the assignment, **where one exists** (e.g. **SOAR**: Sprout reference video; **Watch and Sign**: stimulus video).
- **Purpose:** aspirational target — “here is what fluent looks like.”
- **Status:** partially present for SOAR via Sprout reference; this item **formalizes** it as a first-class **comparison mode** (not only a peripheral reference control).

### 3. Compare to peer (out of scope here)

- Anonymized cohort comparison — **deferred.**
- Requires consent and anonymization infrastructure; tracked in [language-coach-v0.plan.md](language-coach-v0.plan.md) as a **future / optional** item (not a v0 deliverable for pre-coach).

---

## Goal setting in the recording session

### Behavior

1. **Immediately after** a student finishes a recording and **before** they submit, show a **low-friction** prompt: **“What are you working on next time?”** — **one** text field.
2. On **subsequent** sessions, **before** they record, show: **“Last time you said you were working on: [goal].”**  
   This **closes the Deliberate Practice loop** inside the tool without requiring the teacher to intervene on every step.

### Data model (prerequisite for coach)

Stated goals must be stored in a form usable by both product and Language Coach:

| Field            | Description                          |
| ---------------- | ------------------------------------ |
| `studentId`      | Student identity (LTI/Canvas)        |
| `assignmentId`   | Canvas assignment                    |
| `attemptNumber`  | Attempt this goal is attached to     |
| `statedGoal`     | Free text                            |
| `createdAt`      | Timestamp                            |

- This model is a **prerequisite** for [language-coach-v0.plan.md](language-coach-v0.plan.md): the coach must bind formative feedback to a **stated** student goal; without this anchor, the pedagogical contract is weak.

### Placement split

- **Implements in pre-coach:** UI, storage/API, and “last goal” surfacing in the timer/recording flow.
- **Consumer in v0:** Language Coach uses the same `statedGoal` records to scope/tie automated feedback — see the coach plan for integration notes.

---

## Related plans

- [asl_express_import_pipeline.plan.md](asl_express_import_pipeline.plan.md) — may overlap course copy, orphan restore, and cross-course flows (reconcile with course-copy hardening).
- [student_feedback_and_attempts_d6a9ac51.plan.md](student_feedback_and_attempts_d6a9ac51.plan.md) — my-submission, multi-attempt, student feedback (overlaps with return-to-review and attempt lists needed for comparison pickers).
- [language-coach-v0.plan.md](language-coach-v0.plan.md) — peer comparison (deferred) and coach ↔ stated-goal integration.
