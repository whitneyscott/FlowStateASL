import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class LtiLaunchGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const hasSession = !!req.session;
    const hasLtiContext = !!req.session?.ltiContext;
    if (hasLtiContext) return true;
    const hasCookie = !!req.headers.cookie;
    const sid = (req.session as { id?: string })?.id ?? req.sessionID ?? 'none';
    const keys = req.session ? Object.keys(req.session).filter((k) => k !== 'cookie') : [];
    const reason = !hasCookie
      ? 'no_cookie'
      : hasSession && keys.length === 0
        ? 'session_empty'
        : 'missing_ltiContext';
    const message = `LTI context required: ${reason} (hasCookie=${hasCookie} sessionId=${String(sid).slice(0, 12)})`;
    console.warn('[LtiLaunchGuard] 401 path=', req.path, 'reason=', reason, 'hasCookie=', hasCookie, 'sessionKeys=', keys);
    throw new UnauthorizedException({ message, reason });
  }
}
