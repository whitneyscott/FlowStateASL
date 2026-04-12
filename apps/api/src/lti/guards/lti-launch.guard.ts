import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { repairCanvasHostFromRequest } from '../../common/utils/canvas-base-url.util';
import { CourseSettingsService } from '../../course-settings/course-settings.service';

@Injectable()
export class LtiLaunchGuard implements CanActivate {
  constructor(private readonly courseSettings: CourseSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    // Allow GET /api/prompt/submission/:token by token alone (unguessable); video loads even if session expired
    if (req.method === 'GET' && /^\/api\/prompt\/submission\/[^/]+$/.test(req.path)) return true;
    // Short-lived proxy_token grants (no JWT in query); validated inside PromptController
    if (req.method === 'GET' && /^\/api\/prompt\/video-proxy$/.test(req.path)) {
      const q = req.query as { proxy_token?: string | string[] };
      const raw = q.proxy_token;
      const t = Array.isArray(raw) ? raw[0] : raw;
      if (typeof t === 'string' && t.trim().length > 0) return true;
    }
    const hasSession = !!req.session;
    const hasLtiContext = !!req.session?.ltiContext;
    if (hasLtiContext) {
      repairCanvasHostFromRequest(req);
      await this.courseSettings.hydrateTeacherCanvasTokenFromDatabase(req);
      return true;
    }
    const hasBearer = /^Bearer\s+/i.test(req.headers.authorization ?? '');
    const sid = (req.session as { id?: string })?.id ?? req.sessionID ?? 'none';
    const keys = req.session ? Object.keys(req.session).filter((k) => k !== 'cookie') : [];
    const reason = !hasBearer
      ? 'no_bearer'
      : hasSession && keys.length === 0
        ? 'auth_state_empty'
        : 'missing_ltiContext';
    const message = `LTI context required: ${reason} (hasBearer=${hasBearer} sessionId=${String(sid).slice(0, 12)})`;
    console.warn('[LtiLaunchGuard] 401 path=', req.path, 'reason=', reason, 'hasBearer=', hasBearer, 'sessionKeys=', keys);
    throw new UnauthorizedException({ message, reason });
  }
}
