# Render deploy notes

## Pre-deploy command (migrations)

If pre-deploy fails with **Cannot find module `.../dist/apps/api/data/data-source.js`**, your **Render service** is still using an old **Pre-Deploy Command** from the dashboard. That value **overrides** `render.yaml` for existing services.

**Fix:** In [Render Dashboard](https://dashboard.render.com) → your web service → **Settings** → **Pre-Deploy Command**, set exactly:

```bash
npm run db:migrate
```

(or `node scripts/run-migrations.cjs`)

Save and **Clear build cache & deploy** if needed.

The `db:migrate` script finds the compiled data source whether Nx outputs to `dist/apps/api/src/data/` or `dist/apps/api/data/`.

## Start command

Should be:

```bash
node dist/apps/api/src/main.js
```

If the service was created before the blueprint update, confirm **Start Command** in the dashboard matches the above (or what’s in `render.yaml`).
