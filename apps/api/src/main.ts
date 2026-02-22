import 'reflect-metadata';
import express from 'express';
import { join } from 'path';
import { createClient } from 'redis';
import { RedisStore } from 'connect-redis';
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

  const sessionConfig: session.SessionOptions = {
    secret: process.env.SESSION_SECRET ?? 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
    },
  };

  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    const redisClient = createClient({ url: redisUrl });
    redisClient.on('error', (err) => console.error('[Redis]', err));
    await redisClient.connect();
    const redisStore = new RedisStore({ client: redisClient });
    sessionConfig.store = redisStore;
    console.log('[Session] Using Redis store');
  }

  expressApp.use(session(sessionConfig));

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
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',
    credentials: true,
  });

  await app.listen(port, '0.0.0.0');

  const staticRoot = isProduction ? join(__dirname, '..', '..', 'web') : 'N/A';
  console.log(`Listening on port ${port}`);
  console.log(`Static root path: ${staticRoot}`);
}

bootstrap();
