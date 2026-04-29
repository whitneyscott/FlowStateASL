# Re-apply optimizations after Render baseline (cf5ab4c)

## Baseline (current rewind point)

- **Commit:** `cf5ab4c` — *feat(web): Quill font-size picker for prompt and instruction editors*  
- **Use when:** You have **hard-reset** the repo to this commit to match Render (or a clean deploy from this point). All instructions below assume this is **HEAD**.

## Why this file exists

Render was rewound to `cf5ab4c` to avoid instability. A **later** line of work (on this repo’s `feature/youtube-prompts`) added:

1. **Performance and reliability** — fewer duplicate Canvas/heap issues, 429 handling, per-request settings-blob dedupe, concurrency caps, etc.
2. **Prompt image pipeline** — Quill images, course Files upload, JSON embed repair, Canvas file picker for prompts.

**Policy for this project:** re-apply **(1) performance/reliability first** and ship/collect feedback. Only then, **very carefully**, re-apply **(2) image insertion and related API paths**, because images increase HTML/JSON surface area and duplicate-call risk.

## Phase A — Re-apply optimizations (do this first)

Use **cherry-pick** in the order below (oldest first). If a pick conflicts, resolve in the file areas noted; do **not** pull in Phase B commits while resolving Phase A.

| Order | Commit    | Short description |
|------|-----------|-------------------|
| A1   | `8e92b0a` | fix(api): parse prompt embeds with balanced div matching — avoids bad embed region detection when HTML is messy. |
| A2   | `1be5a77` | fix(api): production routing log noise + fatal bootstrap errors |
| A3   | `50b6e2a` | fix(api): stop logging every production SPA GET by default (Render log noise) |
| A4   | `17041aa` | fix(render): Standard plan + 768 MiB V8 heap (Render OOM) — update `render.yaml` / env as in commit |
| A5   | `73fcf07` | fix(api): Canvas 429 — throttle + Retry-After/backoff on REST (see [canvas.service.ts](apps/api/src/canvas/canvas.service.ts)) |
| A6   | `d6c5be6` | **Main perf bundle:** WebM + configured-assignment concurrency cap, per-request **Prompt Manager blob read dedupe** ([prompt-blob-read-request.context.ts](apps/api/src/prompt/prompt-blob-read-request.context.ts), [main.ts](apps/api/src/main.ts) `runWithPromptBlobRequestContext`), [concurrency-pool.util.ts](apps/api/src/common/concurrency-pool.util.ts), [prompt.service.ts](apps/api/src/prompt/prompt.service.ts), [render.yaml](render.yaml), [.env.example](.env.example) |

**Spot-check after Phase A:**

- `npx nx run api:build` and `npx nx run web:build`
- One teacher flow: load configured assignments, save config (watch logs for duplicate blob reads in one request)
- Staging/Render: confirm heap/Standard plan and OAuth scopes still match your Canvas key (no change from `d6c5be6` usually beyond render.yaml)

## Phase B — Do NOT do until Phase A is stable in production

**Prompt + instruction images and Canvas Files integration** (higher risk for embed size, JSON escaping, and extra GETs to Canvas):

| Order | Commit    | Short description |
|------|-----------|-------------------|
| B1   | `380d81e` | feat(web): images in text prompts via Quill + safe HTML sanitization |
| B2   | `8004e4a` | fix(prompt): upload RTE images to Canvas course Files, not data URLs in description |
| B3   | `20a1595` | fix(prompt): repair broken prompts JSON + validate embeds on save ([assignment-description-embed.util.ts](apps/api/src/prompt/assignment-description-embed.util.ts)) |
| B4   | `5cadcab` | feat(prompt): pick images from course Files (API list + [PromptImageSourceModal](apps/web/src/components/PromptImageSourceModal.tsx), OAuth scope additions) |

**Before enabling B1–B4 in production:** confirm `mergeAssignmentDescriptionWithEmbeds` round-trip validation, no huge descriptions over Canvas limits, and monitor Canvas 429/heap after save.

**Optional (same era, mostly viewer/flashcards, not blockers for “optimization”):** there are multiple `fix(viewer)` / Sprout / deck layout commits after `380d81e` on the historical line (e.g. `17965f2`…`a92dec5`); include them only if you need that UI stack — they are separate from the API “optimization” core in Phase A.

## One-line recovery commands (reference)

**Save where you are now (any time before a destructive reset):**

```bash
git branch backup/pre-reset-$(date +%Y%m%d%H%M) HEAD
# or: git tag backup/line-$(date +%Y%m%d) HEAD
```

**This workspace (2026-04-28):** before resetting to `cf5ab4c`, the previous tip was saved as branch **`backup/line-before-reset-202604282052`** (commit `5cadcab` — full line including perf + images). Use that branch to diff or cherry-pick without remote.

**Replay Phase A (from clean tree at `cf5ab4c`):**

```bash
git cherry-pick 8e92b0a
git cherry-pick 1be5a77
git cherry-pick 50b6e2a
git cherry-pick 17041aa
git cherry-pick 73fcf07
git cherry-pick d6c5be6
```

**Later, Phase B (only when ready):**

```bash
git cherry-pick 380d81e
git cherry-pick 8004e4a
git cherry-pick 20a1595
git cherry-pick 5cadcab
```

If cherry-pick fails, fix conflicts and `git cherry-pick --continue`; to abort: `git cherry-pick --abort`.

## Note on duplicate commit messages

`cf5ab4c` and `6965c56` on some branches may share the same *subject* (Quill font-size) but are **different hashes** on different histories. Always use the hash you actually deployed to Render (`cf5ab4c`).

## Related internal todos (historical)

Older brainstorming included: single-flight for settings + assignment list, trim getConfig in getSubmissions, teacher bootstrap bundle — not all are represented as single commits above; **Phase A’s `d6c5be6` + `8e92b0a` + 429/heap** are the main shipped “optimization” set tied to the Render line.

---
*Created: store this file when rolling back; update commit hashes if history is rewritten again.*
