import { createPrivateKey } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { appendLtiLog } from '../common/last-error.store';

let cachedPem: string | null = null;

const LTI_KEY_ERR =
  'LTI_PRIVATE_KEY is required. Add to .env: LTI_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----" (full PEM, double-quoted).';

/**
 * Returns the LTI private key PEM from LTI_PRIVATE_KEY in .env only.
 * Both JWKS and Deep Link signing use this; same source = no key mismatch.
 */
export function getLtiPrivateKeyPem(config: ConfigService): string {
  if (cachedPem !== null) return cachedPem;

  const raw = (config.get<string>('LTI_PRIVATE_KEY') ?? process.env.LTI_PRIVATE_KEY ?? '').trim();
  if (!raw) throw new Error(LTI_KEY_ERR);

  try {
    const pem = raw.replace(/\\n/g, '\n');
    const keyObj = createPrivateKey(pem);
    const details = keyObj.asymmetricKeyDetails;
    const modulusLength = details?.modulusLength ?? 'unknown';
    const type = keyObj.asymmetricKeyType ?? 'unknown';
    appendLtiLog('lti-key', 'LTI_PRIVATE_KEY loaded', {
      type,
      modulusLengthBits: modulusLength,
      modulusLengthOk: typeof modulusLength === 'number' && modulusLength >= 2048,
    });
  } catch (err) {
    appendLtiLog('lti-key', 'LTI_PRIVATE_KEY parse failed (will still return raw)', {
      error: (err as Error).message,
    });
  }

  cachedPem = raw;
  return cachedPem;
}
