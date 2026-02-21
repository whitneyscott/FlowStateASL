import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { LtiService } from '../../lti/lti.service';

@Injectable()
export class TeacherRoleGuard implements CanActivate {
  constructor(private readonly ltiService: LtiService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const ctx = req.session?.ltiContext;
    if (!ctx) throw new ForbiddenException('LTI context required');
    if (this.ltiService.isTeacherRole(ctx.roles)) return true;
    throw new ForbiddenException('Teacher role required');
  }
}
