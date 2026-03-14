# How to Seed the Database

This guide covers seeding the FlowStateASL database, including the SproutVideo playlist cache used for fast deck loading.

## Prerequisites

- **PostgreSQL** — running and reachable
- **Environment variables** — configured in `.env` at the project root

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/flowstateasl`) |
| `SPROUT_KEY` | SproutVideo API key for playlist and video data |

### Optional (for rate limiting)

| Variable | Default | Description |
|----------|---------|-------------|
| `SPROUTVIDEO_VIDEO_FETCH_DELAY_MS` | 300 | Delay between video API calls (ms). Increase (e.g. 500) for initial seed. |
| `SPROUTVIDEO_PLAYLIST_DELAY_MS` | 500 | Delay between playlists (ms). Increase for large accounts. |
| `SPROUTVIDEO_429_THRESHOLD` | 5 | 429 count before auto-increasing delay |
| `SPROUTVIDEO_429_WINDOW_MS` | 60000 | Time window for 429 threshold (ms) |

---

## Step 1: Run Migrations

Create all database tables, including `sprout_playlists`, `sprout_playlist_videos`, and `sync_metadata`:

```bash
npx typeorm migration:run -d apps/api/src/data/data-source.ts
```

Ensure `DATABASE_URL` is set in `.env` before running. The data source loads `.env` automatically.

---

## Step 2: Seed the SproutVideo Cache

The SproutVideo playlist cache is populated by `PlaylistSyncService.sync()`, which runs on a **cron schedule every 6 hours** (at :00 of hours 0, 6, 12, 18).

### Option A: Let the Cron Run (recommended for production)

1. Start the API:
   ```bash
   npm run serve:api
   ```
2. The sync will run automatically at the next scheduled time (within 6 hours).
3. After the first run, subsequent syncs are **incremental** — only playlists updated since the last sync are fetched.

### Option B: Immediate Seed

If you need the cache populated before the next cron run:

1. Start the API as above.
2. The sync runs only via the cron. To trigger it immediately, you can either:
   - Add a one-time admin endpoint (e.g. `POST /api/admin/sync-playlists`) that calls `PlaylistSyncService.sync()`, or
   - Use a standalone script that bootstraps NestJS, runs sync, and exits.

---

## Step 2b: Seed from QTI Zip Files (Alternative)

When QTI exports are available (e.g. from Canvas or Sprout2qti), you can seed playlists directly from zip files in `qtifiles/`:

```bash
npm run seed:qti
```

- Place `.zip` QTI files in `qtifiles/` (or set `QTI_DIR` to another path)
- Each zip is parsed for playlist title, video ids, and video titles (the "answer" in QTI)
- Data is upserted into `sprout_playlists` and `sprout_playlist_videos`

Requires only `DATABASE_URL`; no SproutVideo API key needed. See [QTI-SEED-PLAN.md](QTI-SEED-PLAN.md) for details.

---

## Step 3: Large Accounts (1000+ Playlists)

For accounts with many playlists and videos, SproutVideo enforces **200 requests per minute**. The sync uses:

- **Incremental sync** — only playlists with `updated_at` newer than the last sync are processed.
- **Configurable delays** — increase them for the initial full seed.

Example for initial seed with ~1000 playlists and ~15 videos each:

```bash
# In .env or as env vars when starting the API
SPROUTVIDEO_VIDEO_FETCH_DELAY_MS=500
SPROUTVIDEO_PLAYLIST_DELAY_MS=1000
```

After the first successful sync, you can reduce these for faster incremental runs.

---

## Verification

1. **Check sync metadata:**
   ```sql
   SELECT * FROM sync_metadata WHERE key = 'last_sync_at';
   ```
   A row with a recent timestamp indicates a successful sync.

2. **Check playlist count:**
   ```sql
   SELECT COUNT(*) FROM sprout_playlists;
   ```

3. **Check video count:**
   ```sql
   SELECT COUNT(*) FROM sprout_playlist_videos;
   ```

4. **API logs** — On success, the cron logs:
   ```
   SproutVideo sync complete (full): N playlists, M videos
   ```

---

## Troubleshooting

| Issue | Possible cause | Action |
|-------|----------------|--------|
| `SproutVideo not configured` | `SPROUT_KEY` missing or empty | Set `SPROUT_KEY` in `.env` |
| `429 Too Many Requests` | Rate limit exceeded | Increase `SPROUTVIDEO_VIDEO_FETCH_DELAY_MS` and `SPROUTVIDEO_PLAYLIST_DELAY_MS` |
| Empty cache | Sync not yet run | Start API and wait for cron, or add an immediate sync trigger |
| Migration fails | Invalid `DATABASE_URL` | Verify PostgreSQL is running and the connection string is correct |
