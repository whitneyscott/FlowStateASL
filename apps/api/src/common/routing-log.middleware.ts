import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { sanitizeLtiContext } from './utils/lti-context-value.util';

@Injectable()
export class RoutingLogMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const started = Date.now();
    try {
      if (req.session?.ltiContext) {
        req.session.ltiContext = sanitizeLtiContext(req.session.ltiContext) as typeof req.session.ltiContext;
      }
    } catch (err) {
      console.warn('[RoutingLogMiddleware] sanitizeLtiContext failed:', (err as Error)?.message ?? err);
    }
    const isApi = req.path.startsWith('/api');
    const handledBy = isApi ? 'API controller' : 'Static File Loader (SPA)';
    console.log(`[Routing] ${req.method} ${req.path} -> ${handledBy}`);
    res.on('finish', () => {
      const ms = Date.now() - started;
      if (!isApi) return;
      const isCritical =
        req.path.includes('/api/prompt/upload-video') ||
        req.path.includes('/api/prompt/submit') ||
        req.path.includes('/api/prompt/submissions');
      if (isCritical || ms > 2000 || res.statusCode >= 500) {
        console.log(
          `[API-Metrics] ${req.method} ${req.path} status=${res.statusCode} durationMs=${ms}`,
        );
      }
    });
    next();
  }
}
