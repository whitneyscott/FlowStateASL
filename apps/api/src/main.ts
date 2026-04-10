import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import express from 'express';
import { join } from 'path';

// Load .env from workspace root before any other code (fixes LTI_PRIVATE_KEY etc.)
loadDotenv({ path: resolve(process.cwd(), '.env') });
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DebugExceptionFilter } from './common/debug-exception.filter';
import { renderDebugPage } from './common/debug-page';
import { getBuildMetadata } from './common/build-metadata';

async function bootstrap() {
  const expressApp = express();
  const isProduction = process.env.NODE_ENV === 'production';
  const port = process.env.PORT ?? 3000;

  expressApp.set('trust proxy', 1);

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
