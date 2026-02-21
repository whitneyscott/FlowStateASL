import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class RoutingLogMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const isApi = req.path.startsWith('/api');
    const handledBy = isApi ? 'API controller' : 'Static File Loader (SPA)';
    console.log(`[Routing] ${req.method} ${req.path} -> ${handledBy}`);
    next();
  }
}
