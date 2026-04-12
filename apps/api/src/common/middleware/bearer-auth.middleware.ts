import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { LtiContext } from '../interfaces/lti-context.interface';
import { AuthSessionService } from '../../auth-state/auth-session.service';
import { sanitizeLtiContext } from '../utils/lti-context-value.util';

type MutableSession = {
  id?: string;
  ltiContext?: LtiContext;
  canvasAccessToken?: string;
  ltiLaunchType?: '1.1' | '1.3';
  save: (cb: (err?: unknown) => void) => void;
};

@Injectable()
export class BearerAuthMiddleware implements NestMiddleware {
  constructor(private readonly authSessions: AuthSessionService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const auth = (req.headers.authorization ?? '').trim();
    let bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    // <video src> cannot send Authorization; allow same JWT via query on video-proxy only.
    if (!bearer && req.method === 'GET') {
      const path = (req.path ?? '').toString();
      if (path.includes('video-proxy')) {
        const q = req.query as { access_token?: string | string[] };
        const raw = q.access_token;
        const qt = Array.isArray(raw) ? raw[0] : raw;
        if (typeof qt === 'string' && qt.trim()) bearer = qt.trim();
      }
    }
    const loaded = bearer ? await this.authSessions.getByBearerToken(bearer) : null;

    const session: MutableSession = {
      id: loaded?.row.id,
      ltiContext: loaded?.ctx,
      canvasAccessToken: loaded?.row.canvasAccessToken ?? undefined,
      ltiLaunchType: loaded?.row.ltiLaunchType ?? undefined,
      save: (cb) => {
        if (!loaded?.row?.id) {
          cb();
          return;
        }
        const safeCtx = session.ltiContext
          ? (sanitizeLtiContext(session.ltiContext) as unknown as Record<string, unknown>)
          : undefined;
        void this.authSessions
          .updateSessionState(loaded.row.id, {
            canvasAccessToken: session.canvasAccessToken ?? null,
            ltiLaunchType: session.ltiLaunchType,
            ltiContext: safeCtx,
          })
          .then(() => cb())
          .catch((err) => cb(err));
      },
    };

    (req as unknown as { session?: MutableSession; sessionID?: string }).session = session;
    (req as unknown as { sessionID?: string }).sessionID = loaded?.row?.id ?? '';
    next();
  }
}
