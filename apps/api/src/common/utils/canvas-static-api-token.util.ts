import type { ConfigService } from '@nestjs/config';
import { isGenericCanvasCloudRestBase, normalizeToCanvasRestBase } from './canvas-base-url.util';

function trimEnv(config: ConfigService, key: string): string | null {
  const v = config.get<string>(key);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function hostnameFromRestBase(restBase: string | undefined): string {
  if (!restBase) return '';
  try {
    return new URL(restBase).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when REST base points at Canvas running on this machine (Docker OSS, etc.). */
function isLocalCanvasHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Default host patterns for Tyler Junior College Canvas. Override with comma-separated
 * substrings: CANVAS_API_TOKEN_MATCH_TJC=tjc.instructure.com,some.other.host
 */
function tjcHostPatterns(config: ConfigService): string[] {
  const custom = trimEnv(config, 'CANVAS_API_TOKEN_MATCH_TJC');
  if (custom) {
    return custom
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return ['tjc.instructure.com', 'tjc.edu'];
}

function hostMatchesAny(hostname: string, patterns: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const p of patterns) {
    const pat = p.toLowerCase();
    if (!pat) continue;
    if (h === pat || h.endsWith(`.${pat}`)) return true;
  }
  return false;
}

/**
 * Picks a server-side Canvas access token from env based on the resolved Canvas REST base URL
 * (scheme + host). Used when the user has not completed OAuth (typical student launches).
 *
 * Precedence when host is known:
 * 1. Localhost → CANVAS_API_TOKEN_LOCAL
 * 2. Instructure generic cloud (FFT) → CANVAS_API_TOKEN_FFT
 * 3. TJC patterns → CANVAS_API_TOKEN_TJC
 * 4. Legacy: CANVAS_API_TOKEN_TJC, CANVAS_API_TOKEN, CANVAS_ACCESS_TOKEN
 *
 * If `canvasRestBase` is omitted, falls back to CANVAS_API_BASE_URL from config for host detection.
 */
export function resolveStaticCanvasApiToken(
  config: ConfigService,
  canvasRestBase?: string | null,
): string | null {
  const fromArg = normalizeToCanvasRestBase(canvasRestBase ?? undefined);
  const fromEnv = normalizeToCanvasRestBase(config.get<string>('CANVAS_API_BASE_URL'));
  const effectiveBase = fromArg ?? fromEnv;
  const hostname = hostnameFromRestBase(effectiveBase);

  if (hostname && isLocalCanvasHost(hostname)) {
    const t = trimEnv(config, 'CANVAS_API_TOKEN_LOCAL');
    if (t) return t;
  }

  if (effectiveBase && isGenericCanvasCloudRestBase(effectiveBase)) {
    const t = trimEnv(config, 'CANVAS_API_TOKEN_FFT');
    if (t) return t;
  }

  if (hostname && hostMatchesAny(hostname, tjcHostPatterns(config))) {
    const t = trimEnv(config, 'CANVAS_API_TOKEN_TJC');
    if (t) return t;
  }

  return (
    trimEnv(config, 'CANVAS_API_TOKEN_TJC') ??
    trimEnv(config, 'CANVAS_API_TOKEN') ??
    trimEnv(config, 'CANVAS_ACCESS_TOKEN')
  );
}
