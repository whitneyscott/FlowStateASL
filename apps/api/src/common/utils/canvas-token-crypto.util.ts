import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const VERSION_PREFIX = 'fsenc1:';

/**
 * Derive a 32-byte AES-256 key from CANVAS_TOKEN_ENCRYPTION_KEY:
 * - 64 hex chars → raw 32 bytes
 * - base64 decoding yields exactly 32 bytes → use as raw key
 * - otherwise SHA-256(UTF-8 secret) (convenient for long random strings)
 */
export function deriveCanvasTokenAesKey(secret: string): Buffer {
  const trimmed = secret.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const fromB64 = Buffer.from(trimmed, 'base64');
    if (fromB64.length === 32) {
      return fromB64;
    }
  } catch {
    /* use hash fallback */
  }
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

export function encryptCanvasTokenSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, enc]);
  return `${VERSION_PREFIX}${blob.toString('base64url')}`;
}

function decryptCanvasTokenSecret(stored: string, key: Buffer): string | null {
  if (!stored.startsWith(VERSION_PREFIX)) {
    return null;
  }
  const raw = stored.slice(VERSION_PREFIX.length);
  let blob: Buffer;
  try {
    blob = Buffer.from(raw, 'base64url');
  } catch {
    return null;
  }
  if (blob.length < 12 + 16 + 1) {
    return null;
  }
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

export type CanvasStoredTokenShape = 'empty' | 'encrypted' | 'legacy_plaintext';

/** Classify DB column value shape (does not log or return raw secrets). */
export function getCanvasStoredTokenShape(stored: string | null | undefined): CanvasStoredTokenShape {
  const s = (stored ?? '').trim();
  if (!s) return 'empty';
  if (s.startsWith(VERSION_PREFIX)) return 'encrypted';
  return 'legacy_plaintext';
}

/**
 * Resolve stored token with decrypt outcome for diagnostics.
 * `decryptFailed` is true only when value is fsenc1:, key is present, and GCM decrypt/tag verify fails.
 */
export function resolveStoredCanvasApiTokenDiagnostic(
  stored: string | null | undefined,
  key: Buffer | null,
): { plain: string | null; decryptFailed: boolean } {
  const s = (stored ?? '').trim();
  if (!s) return { plain: null, decryptFailed: false };
  if (!s.startsWith(VERSION_PREFIX)) return { plain: s, decryptFailed: false };
  if (!key) return { plain: null, decryptFailed: false };
  const plain = decryptCanvasTokenSecret(s, key);
  return { plain, decryptFailed: plain === null };
}

/**
 * Turn a DB value into a usable Canvas API token string.
 * - Encrypted values (fsenc1:…) require key; decryption failure → null
 * - Legacy plaintext (no prefix) is returned as-is for migration
 */
export function resolveStoredCanvasApiToken(
  stored: string | null | undefined,
  key: Buffer | null,
): string | null {
  return resolveStoredCanvasApiTokenDiagnostic(stored, key).plain;
}
