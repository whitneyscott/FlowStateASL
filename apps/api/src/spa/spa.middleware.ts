import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { join } from 'path';
import { renderDebugPage } from '../common/debug-page';

/**
 * Serves the React SPA index.html for non-API GET requests (e.g. /flashcards from LTI).
 * Runs before the router. On failure, serves an HTML debug page (like PHP echo) for troubleshooting.
 */
@Injectable()
export class SpaMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    if (
      req.method === 'GET' &&
      !req.path.startsWith('/api') &&
      !req.path.includes('.')
    ) {
      const webRoot = join(__dirname, '..', '..', '..', 'web');
      const indexPath = join(webRoot, 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err) {
          const html = renderDebugPage({
            error: err.message,
            request_path: req.path,
            request_method: req.method,
            resolved_indexPath: indexPath,
            resolved_webRoot: webRoot,
            __dirname,
            hint: 'SpaMiddleware ran but sendFile failed. Check that dist/apps/web exists and contains index.html.',
          });
          res.setHeader('Content-Type', 'text/html').status(500).send(html);
        }
      });
    } else {
      next();
    }
  }
}
