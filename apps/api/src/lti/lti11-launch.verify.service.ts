import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { resolveLtiContextValue } from '../common/utils/lti-context-value.util';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const oauthSignature = require('oauth-signature');

/** Result of successful LTI 1.1 launch verification. */
export interface Lti11VerifyResult {
  courseId: string;
  canvasApiDomain: string;
  canvasBaseUrl: string;
  roles: string;
  /** LTI user identity for session/DB: prefer platform user_id, else Canvas custom id. */
  ltiSub: string;
  /** Canvas REST user id when provided ($Canvas.user.id → custom_canvas_user_id). */
  canvasUserId?: string;
  consumerKey: string;
  /** Additional LTI 1.1 fields for building LtiContext. */
  assignmentId?: string;
  resourceLinkId?: string;
  moduleId?: string;
  resourceLinkTitle?: string;
  toolType?: 'flashcards' | 'prompter';
}

const SECRET_ENV_KEYS = [
  'LTI11_SHARED_SECRET',
  'LTI_1_1_SHARED_SECRET',
  'LTI1_SHARED_SECRET',
  'LTI_SHARED_SECRET',
] as const;

const OAUTH_KEYS = [
  'oauth_consumer_key',
  'oauth_token',
  'oauth_signature_method',
  'oauth_signature',
  'oauth_timestamp',
  'oauth_nonce',
  'oauth_version',
] as const;

const TIMESTAMP_SKEW_SEC = 10 * 60; // 10 minutes

@Injectable()
export class Lti11LaunchVerifyService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Verify OAuth 1.0a signature and extract launch context.
   * @param body Raw POST body (parsed form)
   * @param launchUrl Full URL the platform POSTed to (e.g. https://example.com/api/lti/launch)
   */
  verify(
    body: Record<string, string | string[] | undefined>,
    launchUrl: string
  ): { ok: true; data: Lti11VerifyResult } | { ok: false; error: string } {
    const flat = this.flattenBody(body);
    const consumerKey = (flat.oauth_consumer_key ?? '').toString().trim();
    const signatureMethod = (flat.oauth_signature_method ?? '').toString().trim();
    const signature = (flat.oauth_signature ?? '').toString().trim();
    const timestamp = (flat.oauth_timestamp ?? '').toString().trim();

    if (!consumerKey || !signature || !signatureMethod) {
      return { ok: false, error: 'Missing oauth_consumer_key, oauth_signature, or oauth_signature_method' };
    }

    if (signatureMethod.toUpperCase() !== 'HMAC-SHA1') {
      return { ok: false, error: 'oauth_signature_method must be HMAC-SHA1' };
    }

    const ts = parseInt(timestamp, 10);
    if (Number.isNaN(ts)) {
      return { ok: false, error: 'Invalid oauth_timestamp' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > TIMESTAMP_SKEW_SEC) {
      return { ok: false, error: 'oauth_timestamp outside allowed skew (±10 min)' };
    }

    const secret = this.resolveSecret(consumerKey);
    if (!secret) {
      return { ok: false, error: 'Unknown consumer key or LTI 1.1 shared secret not configured' };
    }

    // Build params for signature: all except oauth_signature
    const paramsForSign: Record<string, string> = {};
    for (const [k, v] of Object.entries(flat)) {
      if (k.toLowerCase() !== 'oauth_signature' && v != null && v !== '') {
        paramsForSign[k] = String(v);
      }
    }

    const expectedSig = oauthSignature.generate('POST', launchUrl, paramsForSign, secret, '', {
      encodeSignature: true,
    });

    // Compare signatures (constant-time)
    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: false, error: 'Invalid OAuth 1.0a signature' };
    }

    const courseId =
      (flat.custom_canvas_course_id ?? flat.canvas_course_id ?? flat.context_id ?? '').toString().trim();
    const canvasApiBase =
      (flat.custom_canvas_api_base_url ??
        flat.custom_canvas_api_domain ??
        flat.custom_canvas_domain ??
        flat.tool_consumer_instance_url ??
        '')
        .toString()
        .trim();
    const roles =
      (flat.custom_roles ?? flat.roles ?? flat.ext_roles ?? flat.canvas_membership_roles ?? '').toString().trim();
    const canvasUserIdRaw = resolveLtiContextValue((flat.custom_canvas_user_id ?? '').toString());
    const ltiPrincipal = (flat.user_id ?? flat.lis_person_sourcedid ?? '').toString().trim();
    const ltiSub = (ltiPrincipal || canvasUserIdRaw).trim();
    const canvasUserId =
      canvasUserIdRaw ||
      (ltiPrincipal && /^\d+$/.test(ltiPrincipal) ? ltiPrincipal : undefined);

    if (!courseId || !ltiSub) {
      return { ok: false, error: 'Missing courseId (custom_canvas_course_id/context_id) or user_id' };
    }

    let canvasBaseUrl = canvasApiBase;
    let canvasApiDomain = '';
    if (canvasApiBase) {
      try {
        const u = new URL(canvasApiBase.startsWith('http') ? canvasApiBase : `https://${canvasApiBase}`);
        canvasBaseUrl = `${u.protocol}//${u.host}`;
        canvasApiDomain = u.hostname;
      } catch {
        canvasApiDomain = canvasApiBase.split(/[/:]/)[0] ?? '';
      }
    }

    const assignmentId = (flat.custom_canvas_assignment_id ?? flat.custom_assignment_id ?? '').toString().trim() || undefined;
    const resourceLinkId = (flat.resource_link_id ?? flat.custom_resource_link_id ?? '').toString().trim() || undefined;
    const moduleId = (flat.custom_module_id ?? flat.custom_canvas_module_id ?? '').toString().trim() || undefined;
    const resourceLinkTitle = (flat.resource_link_title ?? '').toString().trim() || undefined;
    const customToolType = (flat.custom_tool_type ?? flat.tool_type ?? '').toString().trim().toLowerCase();
    const toolType: 'flashcards' | 'prompter' =
      customToolType === 'prompter' ? 'prompter' : 'flashcards';

    return {
      ok: true,
      data: {
        courseId,
        canvasApiDomain,
        canvasBaseUrl,
        roles,
        ltiSub,
        canvasUserId,
        consumerKey,
        assignmentId,
        resourceLinkId,
        moduleId,
        resourceLinkTitle,
        toolType,
      },
    };
  }

  /** Flatten body to string key-value; handle arrays as value[0]. */
  private flattenBody(body: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        out[k] = (v[0] ?? '').toString();
      } else {
        out[k] = String(v);
      }
    }
    return out;
  }

  /** Resolve shared secret for consumer key. */
  private resolveSecret(consumerKey: string): string | null {
    // Single-key: first non-empty from env
    for (const key of SECRET_ENV_KEYS) {
      const val = (this.config.get<string>(key) ?? process.env[key] ?? '').toString().trim();
      if (val) return val;
    }

    // Multi-key: LTI11_SECRETS_JSON = {"consumer_key":"secret",...}
    const jsonRaw = (this.config.get<string>('LTI11_SECRETS_JSON') ?? process.env.LTI11_SECRETS_JSON ?? '').toString().trim();
    if (jsonRaw) {
      try {
        const map = JSON.parse(jsonRaw) as Record<string, string>;
        const secret = map?.[consumerKey] ?? map?.['*'];
        return (secret ?? '').toString().trim() || null;
      } catch {
        return null;
      }
    }

    return null;
  }
}
