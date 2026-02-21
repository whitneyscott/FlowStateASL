import { Injectable } from '@nestjs/common';
import type { LtiContext } from '../common/interfaces/lti-context.interface';

declare module 'express-session' {
  interface SessionData {
    ltiContext?: LtiContext;
  }
}

function extractCanvasDomain(body: Record<string, string>): string | undefined {
  const url =
    (body.tool_consumer_instance_url ?? '').trim() ||
    (body.lis_outcome_service_url ?? '').trim();
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

const TEACHER_PATTERNS = [
  'instructor',
  'administrator',
  'faculty',
  'teacher',
  'staff',
  'contentdeveloper',
  'teachingassistant',
  'ta',
];

@Injectable()
export class LtiService {
  isTeacherRole(roles: string): boolean {
    if (!roles || typeof roles !== 'string') return false;
    const lower = roles.toLowerCase();
    return TEACHER_PATTERNS.some((p) => lower.includes(p));
  }

  extractContext(body: Record<string, string>): LtiContext | null {
    const courseId =
      body.custom_canvas_course_id ??
      body.custom_course_id ??
      body.context_id ??
      '';
    const assignmentId =
      body.custom_canvas_assignment_id ??
      body.custom_assignment_id ??
      '';
    const userId =
      body.custom_canvas_user_id ??
      body.user_id ??
      body.lis_person_sourcedid ??
      '';
    const resourceLinkId =
      (body.resource_link_id ?? body.custom_resource_link_id ?? body.custom_custom_resource_link_id ?? '').trim();
    const moduleId = body.custom_module_id ?? body.custom_canvas_module_id ?? '';
    const roles =
      body.custom_roles ??
      body.roles ??
      body.ext_roles ??
      body.canvas_membership_roles ??
      body.com_instructure_membership_roles ??
      '';
    const resourceLinkTitle =
      (body.resource_link_title ?? body.custom_link_title ?? '').trim() || undefined;
    const lisOutcomeServiceUrl = (body.lis_outcome_service_url ?? '').trim() || undefined;
    const lisResultSourcedid = (body.lis_result_sourcedid ?? '').trim() || undefined;
    const canvasDomain = extractCanvasDomain(body);

    if (!courseId || !userId) return null;
    return {
      courseId,
      assignmentId,
      userId,
      resourceLinkId,
      moduleId,
      toolType: 'prompter',
      roles,
      resourceLinkTitle,
      lisOutcomeServiceUrl,
      lisResultSourcedid,
      canvasDomain,
    };
  }
}
