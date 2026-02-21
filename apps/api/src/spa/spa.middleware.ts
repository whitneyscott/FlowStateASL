import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { join } from 'path';

/**
 * Serves the React SPA index.html for non-API GET requests (e.g. /flashcards from LTI).
 * Runs before the router so we don't get 404 for client-side routes.
 */
@Injectable()
export class SpaMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    if (
      req.method === 'GET' &&
      !req.path.startsWith('/api') &&
      !req.path.includes('.')
    ) {
      const webRoot = join(__dirname, '..', '..', '..', 'web');  // dist/apps/api/src/spa -> dist/apps/web
      const indexPath = join(webRoot, 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err) {
          console.error(`[SPA] GET ${req.path} failed:`, err.message);
          next(err);
        }
      });
    } else {
      next();
    }
  }
}
