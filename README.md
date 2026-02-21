# ASL Express

NestJS + React monorepo for ASL Express Drill and Assess.

## Phase A — Foundation

- Nx monorepo with `apps/api` (NestJS) and `apps/web` (React + Vite + Tailwind CSS)
- TypeORM with PostgreSQL
- DataModule with CONFIG_REPOSITORY and ASSESSMENT_REPOSITORY (Postgres implementations)
- LtiModule: `POST /api/lti/launch/flashcards`, `POST /api/lti/launch/prompter`, `GET /api/lti/context`
- TeacherRoleGuard (8 PHP role patterns)
- React AppRouter, useLtiContext hook, Tailwind baseline

## Phase B — SproutVideo and Canvas Services

- SproutVideoService: fetchAllPlaylists, getSmartVersions, isBlacklisted, filterPlaylists, getPlaylistItems
- CanvasService: getModuleInfo, buildFilterFromModuleName, submitGrade, initiateFileUpload, uploadFileToCanvas, submitAssignmentWithFile, renameAssignment, findAssignmentByName
- GET /api/flashcard/playlists?filter=, GET /api/flashcard/items?playlist_id=, GET /api/canvas/module?course_id=&module_id=

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`, `SPROUT_KEY`, `CANVAS_API_TOKEN`, `CANVAS_DOMAIN`.
2. Run migrations (requires DATABASE_URL in .env):
   `npx typeorm migration:run -d apps/api/src/data/data-source.ts`
3. `npm install`
4. `npm run serve:api` — API on http://localhost:3000
5. `npm run serve:web` — Web on http://localhost:4200 (proxies /api to 3000)

## LTI Launch

POST to `/api/lti/launch/flashcards` or `/api/lti/launch/prompter` with LTI 1.1 parameters (e.g. from Canvas). Redirects to `/flashcards` or `/prompter`. The SPA fetches `GET /api/lti/context` to bootstrap.
