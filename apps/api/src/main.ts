import 'reflect-metadata';
import express from 'express';
import { join } from 'path';
import { Pool } from 'pg';
import connectPgSimple from 'connect-pg-simple';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import session from 'express-session';
import { DebugExceptionFilter } from './common/debug-exception.filter';
import { renderDebugPage } from './common/debug-page';

async function bootstrap() {
  const expressApp = express();
  const isProduction = process.env.NODE_ENV === 'production';
  const port = process.env.PORT ?? 3000;

  expressApp.set('trust proxy', 1);

  const PgSession = connectPgSimple(session);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  pool.on('error', (err) => console.error('[Session] PG pool error', err));

  expressApp.use(
    session({
      store: new PgSession({
        pool,
        createTableIfMissing: true,
      }),
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
  console.log('[Session] Using PostgreSQL store');

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
  console.log(`Listening on port ${port}`);
  console.log(`Static root path: ${staticRoot}`);
}

bootstrap();
