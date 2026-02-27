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
    console.warn('[LtiLaunchGuard] 401: hasSession=', hasSession, 'hasLtiContext=', hasLtiContext, 'path=', req.path);
    throw new UnauthorizedException('LTI context required');
  }
}
