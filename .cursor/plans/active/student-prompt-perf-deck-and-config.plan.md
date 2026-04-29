# Student prompt performance: getConfig, deck build, and SQL dedupe

## Goals

- Cut **GET `/api/prompt/config`** wall time (student-facing; often 6–8s in logs).
- Cut **POST `build-deck-prompts`** / `buildDeckPromptList` wall time (e.g. many selected decks, sequential fetches).
- **Title deduplication at the data boundary** (SQL or sync), so runtime code does not repeat the same O(n) title scan when the store can guarantee uniqueness per `(playlist, normalized title)`.
- **Single source of truth for deck build:** on the happy path, **no live SproutVideo HTTP** for `build-deck-prompts` / `buildDeckPromptList` — use DB rows written by [`PlaylistSyncService`](../../apps/api/src/sproutvideo/playlist-sync.service.ts). Live Sprout only as **fallback** (empty/stale/missing) or for **operational** sync, not as the default student load.

**Expected impact (relative):**

- **Yes — `build-deck-prompts` / deck list should load *much* faster** on the happy path, because the dominant cost today is **outbound Sprout** (multi-playlist, pagination, built-in throttling) and a second **Sprout** batch for `getVideoDurations` when needed. A local (or colocated) `SELECT` replaces that. Magnitude: often **on the order of seconds** down to **hundreds of ms** for the deck-build segment when DB is warm and many decks are in play, subject to `GET /config` and network still in front of it.
- **SQL `DISTINCT ON` / title-uniqueness** removes duplicate-**name** cards in one go and drops redundant JS `Set` dedupe — good for **correctness and a bit of CPU/alloc**, and essential clarity at large N. The **bigger** perf lever is “no Sprout list API,” not the dedupe pass alone.
- **Duplicate `video_id` per `playlist_id`** is **already** prevented by the table primary key `(playlist_id, video_id)`; the redundant case the query targets is **same title, different** `video_id` (or duplicate-title rows from Sprout), not duplicate ids in the key sense.

## 0) Architecture clarification (why it looked like “Sprout + DB”)

**It is not intentional dual-sourcing for the same job.** Today’s code paths differ:

- **Deck card list (hot path):** [`getDeckCardsWithCache`](../../apps/api/src/prompt/prompt.service.ts) calls **only** [`sproutVideo.fetchVideosByPlaylistId`](../../apps/api/src/sproutvideo/sproutvideo.service.ts) — it does **not** read `sprout_playlist_videos` for that list. In-memory title dedupe runs after the API response.
- **Durations on build:** `buildDeckPromptList` may call [`sproutVideo.getVideoDurations`](../../apps/api/src/sproutvideo/sproutvideo.service.ts) (batched HTTP) for selected videos **with missing** `durationSeconds`, and also [`loadVideoDurationsFromDb`](../../apps/api/src/prompt/prompt.service.ts) from the same table. If cards already had durations from a DB-backed read, the Sprout **duration** batch could be **skipped**.
- **Embeds / token elsewhere:** e.g. [`enrichDeckTimelineWithSproutTokensFromDb`](../../apps/api/src/prompt/prompt.service.ts) already loads `embedCode` from **DB** for viewer rows — not from live Sprout.

**What deck-based prompt build actually needs** (for session construction): per selected card, **title**, **Sprout `videoId`**, **security token** (or parse from stored `embed_code`), and **duration** for the timer. All of that can live in [`sprout_playlist_videos`](../../apps/api/src/sproutvideo/entities/sprout-playlist-video.entity.ts) after sync (`title`, `video_id`, `embed_code`, `duration_seconds`, `position`).

**“See the correct way to sign” (model / wrong-answer flow):** If that is a **separate** screen or late step, it can still use the **same** persisted row (id + token from DB) without an extra Sprout list call; any **additional** live Sprout use belongs in that flow or in **on-demand** repair, not in the bulk `build-deck-prompts` path.

**Target state:** one **DB read** (with SQL title dedupe per section 3) per deck, optional parallelization, **no** `fetchVideosByPlaylistId` / `getVideoDurations` in the default case when sync data is present and complete.

## 1) GET config (P0) — see prior analysis

- Coalesce per-request `getAssignment` / hydration Canvas calls in [`getConfig`](../../apps/api/src/prompt/prompt.service.ts) (`~1329+`).
- Revisit **moduleId** live scan cost for learners when stored `moduleId` is already present.
- Optional short-TTL server cache of merged config keyed by course + assignment (+ blob version).

## 2) Deck list build (P1) — DB-only happy path; parallel; Sprout as fallback

- **Implement `getDeckCardsFromSync` (or replace `getDeckCardsWithCache` internals):** load cards from `sprout_playlist_videos` (plus SQL dedupe in section 3) instead of `fetchVideosByPlaylistId` when the table has the rows needed for that `playlist_id`.
- **Optional concurrency:** if still one query per deck, run those queries in parallel with a cap (replaces fully sequential work). A single `WHERE playlist_id = ANY($1)` may reduce round trips when many decks are selected.
- **Remove redundant Sprout on build** when DB has `duration_seconds` and token/embed fields: skip [`getVideoDurations`](../../apps/api/src/sproutvideo/sproutvideo.service.ts) for ids that resolve from DB. Keep **fallback** to live Sprout only when DB is missing/partial (document behavior and logging).
- **Staleness policy:** define when to trigger re-sync or accept fallback (e.g. max age, empty result, or manual admin sync) — do not block student build on “always live” Sprout by default.

## 3) SQL-side unique title per deck (plan iteration: user request)

**Problem today:** After fetching all videos for a deck, [`getDeckCardsWithCache`](../../apps/api/src/prompt/prompt.service.ts) (lines 463–478) does a second pass: `Set` of lowercased titles, skip duplicates. That is correct but **redundant** if the database already represents **at most one row per (playlist_id, title identity)** for deck-building purposes.

**Intended win**

- If the **read query** (or the **sync** pipeline) enforces one row per normalized title per `playlist_id`, the hot path only maps rows to `DeckCardSource` — no duplicate-title `Set` walk.
- For very large decks, **dedupe in SQL** can be cheaper and clearer (single `SELECT` with deterministic pick of one `video_id` per title), and avoids duplicating the same business rule in JS and SQL forever.

**Design options (choose one; can combine):**

- **3a) Read-time dedupe (no schema change):** Query with PostgreSQL `DISTINCT ON (lower(trim(title)))` (or `ROW_NUMBER() OVER (PARTITION BY lower(trim(title)) ORDER BY position, video_id)`) from `sprout_playlist_videos` so each logical card appears once. Tie-break: lowest `position`, then `video_id` — must be **documented** as stable.
- **3b) Sync-time uniqueness (stronger):** When syncing in [`PlaylistSyncService`](../../apps/api/src/sproutvideo/playlist-sync.service.ts), collapse duplicate **titles** in a single playlist to one `video_id` (same tie-break as 3a). Then plain `SELECT ... WHERE playlist_id = ? ORDER BY position` is naturally unique by title. **Product implication:** if Sprout has two different videos with the same title, only one survives; confirm acceptable.

**Sprout live path (fallback only):** If `getDeckCardsWithCache` must still call `fetchVideosByPlaylistId` when DB is empty, keep a **single** `dedupeDeckCardsByTitle(cards)` (or retire it once SQL dedupe is mandatory on all paths). Do **not** treat live Sprout as the primary source for student deck build once DB is authoritative.

**Instrumentation:** Log once per build: row count from API/DB pre-dedupe vs post-dedupe, to measure overlap.

## 4) Out of scope (for this plan)

- Ux “loading” skeletons (P3) — can follow in a small UI follow-up.
- `PromptSettings: load configured assignments` — separate from student Timer; optional later.

## 5) Verification

- Nx `api` tests / existing e2e if any for deck build; manual: large multi-deck assignment, compare prompt list size and no duplicate titles; cold vs warm (cache) timings.

## Completion checklist

- [x] P0: fewer redundant Canvas `getAssignment` in `getConfig` (one snapshot for name + embed read + import hydration; skip live module scan for learners with stored `moduleId`).
- [x] P1: **DB-first deck build** via `sprout_playlist_videos` + `DISTINCT ON` title dedupe; parallel deck fetches (concurrency 8); Sprout fallback when DB empty / error.
- [x] **3a: read-time title dedupe in SQL** for sync table path; JS dedupe retained for Sprout-only path.
- [ ] No regression: round-robin + `totalCards` still matches current behavior (verify in staging / large multi-deck assignment).

## 6) Backlog — embed short keys (low priority, not scheduled)

**Idea:** Version the hidden ASL config embed (e.g. `data-asl-express-v="2"` or internal `fmt` field) and persist **shorter key names** only in the HTML JSON (`t`/`v`/`d` for card rows, etc.), expanding to full [`PromptConfigJson`](../../apps/api/src/prompt/dto/prompt-config.dto.ts) immediately after `JSON.parse` in [`parseAssignmentDescriptionForPromptManager`](../../apps/api/src/prompt/assignment-description-embed.util.ts). Keep reading v1 (long keys) forever or until every assignment has been re-saved.

**Why it’s optional:** Cuts `descLength` and Canvas description payload (on the order of **~15–35%** of the JSON body for very large deck embeds) and helps storage limits; **end-to-end `GET /config` latency** gains are usually **modest** (parsing 10k JSON is cheap vs Canvas RTT + `getAssignment`). Do this if profiling shows description size on the wire matters, or as a follow-up to squeeze bytes—not as the next big latency lever.

**Context:** Deck-based prompt load after recent optimizations (fewer Canvas round trips, module-scan skip, minified JSON, getConfig cache, DB-first deck build, etc.) already compares well to **native Canvas quizzes** at similar “many items” scale—often **faster and more stable** than a huge quiz with question banks, which can be slower or fragile in the browser. Treat short-key embeds as **nice-to-have**, not a must.

**If implemented:** add golden tests (v1 vs v2 → same normalized config; round-trip), and document the key map in one place beside the encode/decode helpers.
