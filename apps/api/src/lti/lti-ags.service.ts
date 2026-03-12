import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { appendLtiLog } from '../common/last-error.store';
import type { LtiContext } from '../common/interfaces/lti-context.interface';

const AGS_SCOPE_SCORE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
const AGS_SCOPE_LINEITEM = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';
const SCORE_MEDIA_TYPE = 'application/vnd.ims.lis.v1.score+json';
const LINEITEM_CONTAINER_MEDIA_TYPE = 'application/vnd.ims.lis.v2.lineitemcontainer+json';

export interface SubmitGradeViaAgsPayload {
  score: number;
  scoreMaximum: number;
  resultContent?: string;
  resultFormat?: 'url' | 'text';
  /** When grading another user (e.g. teacher grading student), pass their Canvas user ID. Otherwise uses ctx.userId. */
  userId?: string;
}

@Injectable()
export class LtiAgsService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Get an AGS access token from the platform using JWT assertion (client_credentials).
   * Uses LTI_PRIVATE_KEY and LTI_CLIENT_ID. Token is for AGS only (scores, lineitems).
   */
  async getAgsAccessToken(ctx: LtiContext): Promise<string> {
    const baseUrl = (ctx.canvasBaseUrl ?? '').toString().replace(/\/$/, '');
    if (!baseUrl) {
      throw new Error('AGS: canvasBaseUrl (from LTI iss) required for token request');
    }
    const tokenUrl = `${baseUrl}/login/oauth2/token`;
    const clientId = (this.config.get<string>('LTI_CLIENT_ID') ?? '').trim();
    if (!clientId) {
      throw new Error('AGS: LTI_CLIENT_ID required for token request');
    }
    const privateKeyPem = this.config.get<string>('LTI_PRIVATE_KEY')?.trim();
    if (!privateKeyPem) {
      throw new Error('AGS: LTI_PRIVATE_KEY required to sign JWT assertion');
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: clientId,
      sub: clientId,
      aud: tokenUrl,
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    };

    const assertion = jwt.sign(payload, privateKeyPem, { algorithm: 'RS256' });

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      scope: [AGS_SCOPE_SCORE, AGS_SCOPE_LINEITEM].join(' '),
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      appendLtiLog('ags', 'getAgsAccessToken failed', { status: res.status, body: text.slice(0, 300) });
      throw new Error(`AGS token request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    let data: { access_token?: string };
    try {
      data = JSON.parse(text) as { access_token?: string };
    } catch {
      throw new Error(`AGS token response not JSON: ${text.slice(0, 100)}`);
    }
    const accessToken = data.access_token?.trim();
    if (!accessToken) {
      throw new Error('AGS token response missing access_token');
    }
    appendLtiLog('ags', 'getAgsAccessToken success', { tokenPreview: `${accessToken.slice(0, 4)}...${accessToken.slice(-4)}` });
    return accessToken;
  }

  /**
   * Resolve the single lineitem URL for posting scores. Uses ctx.agsLineitemUrl if set,
   * otherwise GETs ctx.agsLineitemsUrl and selects the first lineitem (or by resourceLinkId).
   */
  async getLineitemUrl(ctx: LtiContext, accessToken: string): Promise<string> {
    if (ctx.agsLineitemUrl?.trim()) {
      appendLtiLog('ags', 'getLineitemUrl', { source: 'agsLineitemUrl', url: ctx.agsLineitemUrl });
      return ctx.agsLineitemUrl.trim();
    }
    const lineitemsUrl = ctx.agsLineitemsUrl?.trim();
    if (!lineitemsUrl) {
      throw new Error('AGS: agsLineitemUrl and agsLineitemsUrl both missing (enable AGS on Developer Key)');
    }
    const res = await fetch(lineitemsUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: LINEITEM_CONTAINER_MEDIA_TYPE,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      appendLtiLog('ags', 'getLineitemUrl GET lineitems failed', { status: res.status, url: lineitemsUrl });
      throw new Error(`AGS GET lineitems failed: ${res.status} ${text.slice(0, 200)}`);
    }
    let list: Array<{ id?: string; resourceLinkId?: string; url?: string }>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        list = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { body?: unknown[] }).body)) {
        list = (parsed as { body: Array<{ id?: string; resourceLinkId?: string; url?: string }> }).body;
      } else {
        list = [];
      }
    } catch {
      throw new Error(`AGS lineitems response not JSON: ${text.slice(0, 100)}`);
    }
    const linkId = ctx.resourceLinkId?.trim();
    const item = linkId
      ? list.find((e) => (e.resourceLinkId ?? '').toString() === linkId)
      : list[0];
    const url = item?.id ?? (item as { url?: string })?.url;
    if (!url) {
      throw new Error('AGS: no lineitem found in lineitems response');
    }
    appendLtiLog('ags', 'getLineitemUrl', { source: 'lineitems', url });
    return typeof url === 'string' ? url : String(url);
  }

  /**
   * POST a score to the lineitem's /scores endpoint (IMS AGS).
   * Optionally includes comment (e.g. resultContent as URL or text for Submission Review).
   */
  async postScore(
    lineitemUrl: string,
    accessToken: string,
    userId: string,
    score: number,
    scoreMaximum: number,
    options?: { comment?: string },
  ): Promise<void> {
    const scoresUrl = lineitemUrl.replace(/\/?$/, '') + '/scores';
    const timestamp = new Date().toISOString();
    const payload: Record<string, unknown> = {
      userId,
      scoreGiven: score,
      scoreMaximum,
      activityProgress: 'Completed',
      gradingProgress: 'FullyGraded',
      timestamp,
    };
    if (options?.comment?.trim()) {
      payload.comment = options.comment.trim();
    }
    const body = JSON.stringify(payload);
    const res = await fetch(scoresUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': SCORE_MEDIA_TYPE,
      },
      body,
    });
    const responseText = await res.text();
    if (!res.ok) {
      appendLtiLog('ags', 'postScore failed', { status: res.status, scoresUrl, bodyPreview: responseText.slice(0, 200) });
      throw new Error(`AGS postScore failed: ${res.status} ${responseText.slice(0, 200)}`);
    }
    appendLtiLog('ags', 'postScore success', { scoresUrl, userId, score, scoreMaximum });
  }

  /**
   * Submit a grade via AGS: get token, resolve lineitem, POST score.
   * Optional resultContent (Step 11d) is sent as the score comment (URL or text for Submission Review).
   */
  async submitGradeViaAgs(ctx: LtiContext, payload: SubmitGradeViaAgsPayload): Promise<void> {
    const { score, scoreMaximum, resultContent, userId: payloadUserId } = payload;
    const userId = payloadUserId?.trim() || ctx.userId;
    appendLtiLog('ags', 'submitGradeViaAgs', {
      userId,
      score,
      scoreMaximum,
      hasResultContent: !!resultContent?.trim(),
    });
    const accessToken = await this.getAgsAccessToken(ctx);
    const lineitemUrl = await this.getLineitemUrl(ctx, accessToken);
    const comment = resultContent?.trim() || undefined;
    await this.postScore(lineitemUrl, accessToken, userId, score, scoreMaximum, {
      comment,
    });
  }
}
