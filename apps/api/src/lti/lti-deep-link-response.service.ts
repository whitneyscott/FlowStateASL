import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { appendLtiLog } from '../common/last-error.store';

const LTI_MSG_TYPE = 'https://purl.imsglobal.org/spec/lti/claim/message_type';
const LTI_VERSION = 'https://purl.imsglobal.org/spec/lti/claim/version';
const LTI_DEPLOYMENT_ID = 'https://purl.imsglobal.org/spec/lti/claim/deployment_id';
const LTI_DL_CONTENT_ITEMS = 'https://purl.imsglobal.org/spec/lti-dl/claim/content_items';
const LTI_DL_DATA = 'https://purl.imsglobal.org/spec/lti-dl/claim/data';

@Injectable()
export class LtiDeepLinkResponseService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Build the LtiDeepLinkingResponse JWT and return HTML that auto-posts to the platform's deep_link_return_url.
   */
  buildResponseHtml(
    ctx: LtiContext,
    fileUrl: string,
    title: string = 'ASL submission',
  ): string {
    const clientId = (this.config.get<string>('LTI_CLIENT_ID') ?? '').trim();
    const privateKeyPem = this.config.get<string>('LTI_PRIVATE_KEY')?.trim();
    if (!clientId || !privateKeyPem) {
      throw new Error('LTI_CLIENT_ID and LTI_PRIVATE_KEY required for Deep Linking response');
    }
    const aud = ctx.platformIss ?? ctx.canvasBaseUrl ?? '';
    if (!aud) {
      throw new Error('Platform issuer (platformIss/canvasBaseUrl) required for Deep Linking response');
    }
    const returnUrl = ctx.deepLinkReturnUrl?.trim();
    if (!returnUrl) {
      throw new Error('deepLinkReturnUrl required for Deep Linking response');
    }

    const contentItems = [
      {
        type: 'file',
        url: fileUrl,
        title,
      },
    ];

    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: clientId,
      aud,
      iat: now,
      exp: now + 300,
      [LTI_MSG_TYPE]: 'LtiDeepLinkingResponse',
      [LTI_VERSION]: '1.3.0',
      [LTI_DL_CONTENT_ITEMS]: contentItems,
    };
    if (ctx.deploymentId) {
      payload[LTI_DEPLOYMENT_ID] = ctx.deploymentId;
    }
    if (ctx.deepLinkData != null && ctx.deepLinkData !== '') {
      payload[LTI_DL_DATA] = ctx.deepLinkData;
    }

    const signed = jwt.sign(payload, privateKeyPem, { algorithm: 'RS256' });
    appendLtiLog('deep-link', 'response built', {
      returnUrl: returnUrl.slice(0, 60) + '...',
      contentItems: contentItems.length,
    });

    return this.renderFormHtml(returnUrl, signed);
  }

  private renderFormHtml(deepLinkReturnUrl: string, jwtParam: string): string {
    const escapedUrl = this.escapeHtml(deepLinkReturnUrl);
    const escapedJwt = this.escapeHtml(jwtParam);
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Submitting to Canvas</title>
</head>
<body>
  <p>Submitting your submission to Canvas...</p>
  <form id="dlform" method="POST" action="${escapedUrl}">
    <input type="hidden" name="JWT" value="${escapedJwt}" />
    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>document.getElementById('dlform').submit();</script>
</body>
</html>`;
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
