import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jose from 'jose';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { appendLtiLog } from '../common/last-error.store';
import { getLtiPrivateKeyPem } from './lti-key.util';

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
   * Production: uses file content item so Canvas fetches and owns the video.
   * Development: uses ltiResourceLink (Canvas cannot reach private IPs locally).
   */
  async buildResponseHtml(
    ctx: LtiContext,
    submissionToken: string,
    title: string = 'ASL Express Video Submission',
  ): Promise<string> {
    const appUrl = (this.config.get<string>('APP_URL') ?? process.env.APP_URL ?? '').trim().replace(/\/$/, '');
    if (!appUrl) throw new Error('APP_URL required for content_items url');
    const launchUrl = `${appUrl}/api/lti/launch`;
    appendLtiLog('deep-link', 'buildResponseHtml: ENTER', { launchUrl, submissionToken: submissionToken.slice(0, 8) + '...' });
    const clientId = (this.config.get<string>('LTI_PROMPTER_CLIENT_ID') ?? process.env.LTI_PROMPTER_CLIENT_ID ?? '').trim();
    if (!clientId) {
      throw new Error('Deep Linking requires LTI_PROMPTER_CLIENT_ID. Add to .env (Client ID from Prompter Developer Key).');
    }
    const privateKeyPem = getLtiPrivateKeyPem(this.config);
    const aud = ctx.platformIss ?? ctx.canvasBaseUrl ?? '';
    if (!aud) {
      throw new Error('Platform issuer (platformIss/canvasBaseUrl) required for Deep Linking response');
    }
    const returnUrl = ctx.deepLinkReturnUrl?.trim();
    if (!returnUrl) {
      throw new Error('deepLinkReturnUrl required for Deep Linking response');
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const contentItems = isProduction
      ? [
          {
            type: 'file',
            title,
            url: `${appUrl}/api/lti/deep-link-file/${submissionToken}`,
            mediaType: 'video/webm',
          },
        ]
      : [
          {
            type: 'ltiResourceLink',
            title,
            url: launchUrl,
            custom: {
              submission_token: submissionToken,
              tool_type: 'prompter',
            },
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

    const privateKey = await jose.importPKCS8(
      privateKeyPem.replace(/\\n/g, '\n'),
      'RS256'
    );
    const signed = await new jose.SignJWT(payload as jose.JWTPayload)
      .setProtectedHeader({ alg: 'RS256', kid: 'default' })
      .sign(privateKey);
    appendLtiLog('deep-link', 'response built', {
      returnUrl: returnUrl.slice(0, 60) + '...',
      contentItems: contentItems.length,
      jwtLength: signed.length,
      jwt: signed,
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
  <script>
    (function() {
      var form = document.getElementById('dlform');
      if (!form) return;
      var inp = document.querySelector('input[name="JWT"]');
      var jwt = inp ? inp.value : '';
      var storageKey = 'lti_dl_sent_' + (jwt ? jwt.slice(-32) : Date.now());
      try {
        if (sessionStorage.getItem(storageKey)) {
          return;
        }
        sessionStorage.setItem(storageKey, '1');
      } catch (e) {}
      form.addEventListener('submit', function(e) {
        if (sessionStorage.getItem(storageKey + '_done')) {
          e.preventDefault();
          return false;
        }
        try { sessionStorage.setItem(storageKey + '_done', '1'); } catch (e2) {}
      });
      if (jwt) {
        try {
          function b64decode(str) {
            return JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/')))));
          }
          var parts = jwt.split('.');
          var header = b64decode(parts[0]);
          var payload = b64decode(parts[1]);
          console.log('[LTI Deep Link] JWT payload (all claims):', payload);
        } catch (e) {}
      }
      form.submit();
    })();
  </script>
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
