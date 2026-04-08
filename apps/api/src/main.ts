import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import express from 'express';
import { join } from 'path';
import type { Store } from 'express-session';

// Load .env from workspace root before any other code (fixes LTI_PRIVATE_KEY etc.)
loadDotenv({ path: resolve(process.cwd(), '.env') });
import { Pool } from 'pg';
import connectPgSimple from 'connect-pg-simple';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import session from 'express-session';
import { DebugExceptionFilter } from './common/debug-exception.filter';
import { renderDebugPage } from './common/debug-page';
import { getBuildMetadata } from './common/build-metadata';

async function bootstrap() {
  const expressApp = express();
  const isProduction = process.env.NODE_ENV === 'production';
  const port = process.env.PORT ?? 3000;
  const redisUrl = (process.env.REDIS_URL ?? '').trim();

  expressApp.set('trust proxy', 1);

  const PgSession = connectPgSimple(session);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    max: Number.parseInt(process.env.SESSION_PG_POOL_MAX ?? '12', 10) || 12,
    connectionTimeoutMillis: Number.parseInt(process.env.SESSION_PG_CONNECT_TIMEOUT_MS ?? '8000', 10) || 8000,
    idleTimeoutMillis: Number.parseInt(process.env.SESSION_PG_IDLE_TIMEOUT_MS ?? '30000', 10) || 30000,
  });
  pool.on('error', (err) => console.error('[Session] PG pool error', err));

  let sessionStore: Store;
  let usingRedisSession = false;
  if (redisUrl) {
    try {
      // Optional dependency path: if redis/connect-redis are unavailable, fall back to PG sessions.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createClient } = require('redis') as { createClient: (opts: { url: string }) => { on: (event: string, cb: (err: Error) => void) => void; connect: () => Promise<void> } };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RedisStore } = require('connect-redis') as { RedisStore: new (opts: { client: unknown; prefix?: string }) => Store };
      const redisClient = createClient({ url: redisUrl });
      redisClient.on('error', (err: Error) => console.error('[Session] Redis client error', err));
      await redisClient.connect();
      sessionStore = new RedisStore({
        client: redisClient,
        prefix: process.env.REDIS_SESSION_PREFIX ?? 'sess:',
      });
      usingRedisSession = true;
      console.log('[Session] Using Redis session store');
    } catch (err) {
      console.warn('[Session] Redis unavailable, falling back to PostgreSQL session store:', err instanceof Error ? err.message : String(err));
      sessionStore = new PgSession({
        pool,
        createTableIfMissing: true,
      });
    }
  } else {
    sessionStore = new PgSession({
      pool,
      createTableIfMissing: true,
    });
  }

  expressApp.use(
    session({
      store: sessionStore,
      secret: process.env.SESSION_SECRET ?? 'dev-secret-change-in-production',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
      },
    }),
  );
  if (!usingRedisSession) {
    console.log('[Session] Using PostgreSQL session store');
  }

  // In development only: clear all sessions on startup for a clean slate
  if (process.env.NODE_ENV !== 'production') {
    try {
      const result = await pool.query('DELETE FROM session');
      console.log(`[Session] Cleared ${result.rowCount ?? 0} session(s) (dev startup)`);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== '42P01') {
        console.warn('[Session] Dev clear failed:', (err as Error).message);
      }
    }
  }

  // Restore LTI context from token when session is empty (e.g. after refresh)
  expressApp.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    const hasContext = !!(req.session as { ltiContext?: unknown })?.ltiContext;
    if (hasContext) return next();
    const token =
      (req.query.lti_token as string) ||
      (req.headers['x-lti-token'] as string) ||
      '';
    if (!token.trim()) return next();
    const { getLtiToken } = require('./lti/lti-token.store');
    const { sanitizeLtiContext } = require('./common/utils/lti-context-value.util');
    const ctx = getLtiToken(token.trim());
    if (!ctx || !req.session) return next();
    (req.session as { ltiContext?: unknown }).ltiContext = sanitizeLtiContext(ctx);
    req.session.save((err: Error | null) => {
      if (err) console.error('[Session] restore from lti_token save failed', err.message);
      next();
    });
  });

  if (isProduction) {
    const webRoot = join(__dirname, '..', '..', 'web');
    const indexPath = join(webRoot, 'index.html');
    expressApp.use((req, res, next) => {
      if (
        req.method === 'GET' &&
        !req.path.startsWith('/api') &&
        !req.path.includes('.')
      ) {
        console.log(`[Routing] ${req.method} ${req.path} -> Static File Loader (SPA)`);
        res.sendFile(indexPath, (err) => {
          if (err) {
            const exactDir = join(webRoot, req.path);
            const html = renderDebugPage({
              statusCode: 500,
              handler: 'Raw Express SPA handler (main.ts)',
              error: err.message,
              request_path: req.path,
              request_method: req.method,
              resolved_indexPath: indexPath,
              resolved_webRoot: webRoot,
              exact_directory_looked_in: exactDir,
              __dirname,
            });
            res.setHeader('Content-Type', 'text/html').status(500).send(html);
          }
        });
      } else {
        next();
      }
    });
  }

  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp));
  app.useGlobalFilters(new DebugExceptionFilter());
  app.setGlobalPrefix('api');
  const corsOrigin = process.env.CORS_ORIGIN ?? (isProduction ? 'https://flowstateasl.onrender.com' : 'http://localhost:4200');
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });

  await app.listen(port, '0.0.0.0');

  const staticRoot = isProduction ? join(__dirname, '..', '..', 'web') : 'N/A';
  const build = getBuildMetadata();
  console.log(`Listening on port ${port}`);
  console.log(`Static root path: ${staticRoot}`);
  console.log(
    `[Build] git=${build.gitCommitShort ?? 'unknown'} full=${build.gitCommit ?? '(none)'} source=${build.source ?? '(set RENDER_GIT_COMMIT or GIT_COMMIT)'}`,
  );
  console.log('[Build] Verify deploy: GET /api/health (fields: gitCommit, gitCommitShort, gitCommitSource)');
}

bootstrap();
