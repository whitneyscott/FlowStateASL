import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { sanitizeLtiContext } from './utils/lti-context-value.util';

@Injectable()
export class RoutingLogMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
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
    next();
  }
}
