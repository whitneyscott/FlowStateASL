# Render deploy — correct paths

`nx build api` emits compiled JS under **`dist/apps/api/src/`** (same folder layout as `apps/api/src/`).

Use **exactly** these commands (also set in `render.yaml`):

| Step | Command |
|------|---------|
| **Start** | `node dist/apps/api/src/main.js` |
| **Pre-deploy (migrations)** | `npx typeorm migration:run -d dist/apps/api/src/data/data-source.js` |

### Wrong paths (do not use)

- `dist/apps/api/main.js` — file is not there  
- `dist/apps/api/data/data-source.js` — file is not there (must include **`src`**)

Those wrong paths were introduced by mistake in git history; the build layout did not change.

### Dashboard overrides `render.yaml`

If pre-deploy or start still fails with a path **without** `src`, open [Render Dashboard](https://dashboard.render.com) → your service → **Settings** and replace **Pre-Deploy Command** / **Start Command** with the table above. Saved dashboard values can override the blueprint for an existing service.
