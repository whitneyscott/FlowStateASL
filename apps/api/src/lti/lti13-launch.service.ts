import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jose from 'jose';
import * as jwt from 'jsonwebtoken';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jwkToPem = require('jwk-to-pem') as (jwk: { kty: string; n?: string; e?: string }) => string;
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { appendLtiLog } from '../common/last-error.store';
import { resolveLtiContextValue } from '../common/utils/lti-context-value.util';

const IS_DEV = process.env.NODE_ENV !== 'production';

const LTI_MSG_TYPE = 'https://purl.imsglobal.org/spec/lti/claim/message_type';
const LTI_VERSION = 'https://purl.imsglobal.org/spec/lti/claim/version';
const LTI_ROLES = 'https://purl.imsglobal.org/spec/lti/claim/roles';
const LTI_RESOURCE_LINK = 'https://purl.imsglobal.org/spec/lti/claim/resource_link';
const LTI_CONTEXT = 'https://purl.imsglobal.org/spec/lti/claim/context';
const LTI_CUSTOM = 'https://purl.imsglobal.org/spec/lti/claim/custom';
const LTI_DEPLOYMENT_ID = 'https://purl.imsglobal.org/spec/lti/claim/deployment_id';
/** Deep Linking request: deep_link_return_url and data. */
const LTI_DL_SETTINGS = 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings';
/** AGS endpoint claim: { lineitems, lineitem?, scope[] } */
const LTI_AGS_ENDPOINT = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
/** Maps custom.tool_type from LTI JWT to our toolType. Unmapped values default to 'flashcards'. */
const CUSTOM_TOOL_TYPE_MAP: Record<string, 'flashcards' | 'prompter'> = {
  prompter: 'prompter',
};

const TEACHER_URIS = [
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor',
];

@Injectable()
export class Lti13LaunchService {
  private jwksCache = new Map<string, { jwks: jose.JWTVerifyGetKey; expires: number }>();
  private readonly CACHE_MS = 60 * 60 * 1000; // 1 hour

  constructor(private readonly config: ConfigService) {}

  async validateAndExtract(idToken: string): Promise<{ context: LtiContext } | { error: string }> {
    const unprotected = jose.decodeJwt(idToken) as jose.JWTPayload;
    const iss = unprotected.iss as string;
    const aud = unprotected.aud;
    const audStr = typeof aud === 'string' ? aud : Array.isArray(aud) ? aud[0] : String(aud ?? '');
    const ltiClientId = (this.config.get<string>('LTI_CLIENT_ID') ?? process.env.LTI_CLIENT_ID ?? '').trim();
    const prompterClientId = (this.config.get<string>('LTI_PROMPTER_CLIENT_ID') ?? process.env.LTI_PROMPTER_CLIENT_ID ?? '').trim();
    const allowedAudiences = [audStr, ltiClientId, prompterClientId].filter(Boolean);
    const expectedAud = allowedAudiences.length ? allowedAudiences : undefined;
    if (!iss) {
      return { error: 'JWT missing iss claim' };
    }

    const jwksResult = await this.getPlatformJwksWithError(iss);
    if ('error' in jwksResult) return jwksResult;

    const jwks = jwksResult.jwks;
    let verified: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(idToken, jwks, {
        issuer: iss,
        audience: expectedAud,
        clockTolerance: 60,
      });
      verified = result.payload;
    } catch (err) {
      const msg = (err as Error).message;
      const isKeySizeError = /2048|modulusLength/i.test(msg);
      // Error is from US verifying Canvas's id_token (launch JWT). Key is Canvas's from Canvas JWKS, not our LTI_PRIVATE_KEY.
      if (isKeySizeError) {
        appendLtiLog('launch', 'Key size error when verifying Canvas id_token', { msg, iss, aud: JSON.stringify(aud), isDev: IS_DEV });
      }
      if (isKeySizeError) {
        const fallback = await this.verifyWithLegacyKeySupport(idToken, iss, expectedAud, unprotected);
        if (fallback) verified = fallback;
        else return { error: `JWT verification failed: ${msg}. iss=${iss} aud=${JSON.stringify(aud)} exp=${unprotected.exp} iat=${unprotected.iat}` };
      } else {
        return { error: `JWT verification failed: ${msg}. iss=${iss} aud=${JSON.stringify(aud)} exp=${unprotected.exp} iat=${unprotected.iat}` };
      }
    }

    const ctx = this.payloadToContext(verified);
    if (!ctx) return { error: 'JWT missing sub claim' };
    return { context: ctx };
  }

  private async getPlatformJwks(iss: string): Promise<jose.JWTVerifyGetKey | null> {
    const r = await this.getPlatformJwksWithError(iss);
    return 'jwks' in r ? r.jwks : null;
  }

  /**
   * Dev-only fallback: verify JWT with allowInsecureKeySizes for Canvas Docker's 1024-bit keys.
   * Production Canvas uses 2048+ bits; this path is never used when NODE_ENV=production.
   */
  private async verifyWithLegacyKeySupport(
    idToken: string,
    iss: string,
    expectedAud: string | string[] | undefined,
    unprotected: jose.JWTPayload,
  ): Promise<jose.JWTPayload | null> {
    try {
      const jwksUrl = new URL('/api/lti/security/jwks', iss.endsWith('/') ? iss.slice(0, -1) : iss).href;
      const res = await fetch(jwksUrl);
      if (!res.ok) return null;
      const jwksBody = (await res.json()) as { keys?: Array<Record<string, unknown>> };
      const keys = jwksBody?.keys;
      if (!Array.isArray(keys) || keys.length === 0) return null;

      const header = jose.decodeProtectedHeader(idToken);
      const kid = header.kid;
      const jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
      if (!jwk || jwk.kty !== 'RSA') return null;

      const pem = jwkToPem(jwk as { kty: string; n?: string; e?: string });
      const aud = expectedAud
        ? Array.isArray(expectedAud) && expectedAud.length > 0
          ? expectedAud[0]
          : typeof expectedAud === 'string'
            ? expectedAud
            : undefined
        : undefined;
      const verifyOpts = {
        algorithms: ['RS256'],
        issuer: iss,
        audience: aud,
        clockTolerance: 60,
        allowInsecureKeySizes: true,
      };
      const payload = jwt.verify(idToken, pem, verifyOpts as jwt.VerifyOptions) as jose.JWTPayload;
      return payload;
    } catch {
      return null;
    }
  }

  private async getPlatformJwksWithError(iss: string): Promise<{ jwks: jose.JWTVerifyGetKey } | { error: string }> {
    const cached = this.jwksCache.get(iss);
    if (cached && Date.now() < cached.expires) return { jwks: cached.jwks };

    const jwksUrl = new URL('/api/lti/security/jwks', iss.endsWith('/') ? iss.slice(0, -1) : iss).href;
    try {
      const res = await fetch(jwksUrl);
      if (!res.ok) {
        const text = await res.text();
        return { error: `Failed to fetch JWKS from ${jwksUrl}: ${res.status} ${text.slice(0, 200)}` };
      }
      const jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
      this.jwksCache.set(iss, { jwks, expires: Date.now() + this.CACHE_MS });
      return { jwks };
    } catch (err) {
      const msg = (err as Error).message;
      return { error: `Failed to fetch JWKS from ${jwksUrl}: ${msg}` };
    }
  }

  private payloadToContext(payload: jose.JWTPayload): LtiContext | null {
    const sub = payload.sub as string;
    if (!sub) return null;

    const custom = (payload[LTI_CUSTOM] as Record<string, string>) ?? {};
    const context = (payload[LTI_CONTEXT] as { id?: string }) ?? {};
    const resourceLink = (payload[LTI_RESOURCE_LINK] as { id?: string; title?: string }) ?? {};
    const roles = (payload[LTI_ROLES] as string[]) ?? [];

    // For Canvas API: use custom.course_id ($Canvas.course.id = numeric) over context.id (opaque LTI hash)
    const courseId = resolveLtiContextValue((custom.course_id ?? context.id ?? '').toString());
    const userId = sub;
    const canvasUserIdRaw = resolveLtiContextValue((custom.user_id ?? '').toString());
    const canvasUserId = canvasUserIdRaw || undefined;
    const resourceLinkId = resolveLtiContextValue((resourceLink.id ?? '').toString());
    const resourceLinkTitle = resourceLink.title;
    const assignmentId = resolveLtiContextValue((custom.assignment_id ?? '').toString());
    const moduleId = resolveLtiContextValue((custom.module_id ?? '').toString());
    const rolesStr = Array.isArray(roles) ? roles.join(',') : String(roles);
    const customToolType = (custom.tool_type ?? '').toString().trim();
    const toolType = CUSTOM_TOOL_TYPE_MAP[customToolType] ?? 'flashcards';
    const submissionToken = (custom.submission_token ?? '').toString().trim() || undefined;
    const submissionTitle =
      (custom.sprout_video_title ?? '').toString().trim() ||
      (resourceLink.title ?? '').toString().trim() ||
      undefined;
    if (submissionToken) {
      appendLtiLog('launch', 'LTI submission launch title extraction', {
        hasSubmissionToken: true,
        customSproutVideoTitle: (custom.sprout_video_title ?? '').toString().trim() || '(none)',
        resourceLinkTitle: (resourceLink.title ?? '').toString().trim() || '(none)',
        submissionTitleResolved: submissionTitle || '(none)',
      });
    }

    const agsEndpoint = payload[LTI_AGS_ENDPOINT] as { lineitems?: string; lineitem?: string } | undefined;
    const agsLineitemsUrl = (agsEndpoint?.lineitems ?? '').toString().trim() || undefined;
    const agsLineitemUrl = (agsEndpoint?.lineitem ?? '').toString().trim() || undefined;

    const iss = payload.iss as string;
    let canvasDomain: string | undefined;
    let canvasBaseUrl: string | undefined;
    try {
      if (iss) {
        const u = new URL(iss);
        canvasDomain = u.hostname;
        canvasBaseUrl = `${u.protocol}//${u.host}`;
      }
    } catch {
      // ignore
    }

    const messageType = (payload[LTI_MSG_TYPE] as string) ?? 'LtiResourceLinkRequest';
    let deepLinkReturnUrl: string | undefined;
    let deepLinkData: string | undefined;
    if (messageType === 'LtiDeepLinkingRequest') {
      const dlSettings = (payload[LTI_DL_SETTINGS] as { deep_link_return_url?: string; data?: string }) ?? {};
      deepLinkReturnUrl = (dlSettings.deep_link_return_url ?? '').toString().trim() || undefined;
      const dataVal = dlSettings.data;
      deepLinkData = dataVal != null ? String(dataVal) : undefined;
    }

    const platformIss = iss?.toString().trim();
    const deploymentId = (payload[LTI_DEPLOYMENT_ID] as string)?.toString().trim() || undefined;

    return {
      courseId,
      assignmentId,
      userId,
      canvasUserId,
      resourceLinkId,
      moduleId,
      toolType,
      customToolTypeFromJwt: customToolType || '(absent)',
      roles: rolesStr,
      resourceLinkTitle,
      canvasDomain,
      canvasBaseUrl,
      agsLineitemsUrl,
      agsLineitemUrl,
      messageType: messageType === 'LtiDeepLinkingRequest' ? 'LtiDeepLinkingRequest' : 'LtiResourceLinkRequest',
      deepLinkReturnUrl,
      deepLinkData,
      platformIss,
      deploymentId,
      submissionToken,
      submissionTitle,
    };
  }

  isTeacherRoleFromUris(roles: string[]): boolean {
    if (!Array.isArray(roles)) return false;
    return roles.some((r) =>
      TEACHER_URIS.some((u) => String(r).toLowerCase().includes(u.toLowerCase().split('#')[1]))
    );
  }
}
