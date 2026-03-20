import type { LtiContext } from '../interfaces/lti-context.interface';
import type { Request } from 'express';
import { appendLtiLog } from '../last-error.store';

/**
 * JWT `iss` for Instructure-hosted Canvas is often this host — it is NOT the per-school REST API base.
 * Using it for /api/v1 calls breaks OAuth and announcements; prefer $Canvas.api.domain or Referer repair.
 */
const GENERIC_CANVAS_CLOUD_REST_HOSTS = new Set([
  'canvas.instructure.com',
  'canvas.beta.instructure.com',
  'canvas.test.instructure.com',
]);

export function normalizeToCanvasRestBase(raw: string | null | undefined): string | undefined {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return undefined;
  try {
    const withScheme = t.startsWith('http://') || t.startsWith('https://') ? t : `https://${t}`;
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

export function isGenericCanvasCloudRestBase(base: string | null | undefined): boolean {
  const n = normalizeToCanvasRestBase(base);
  if (!n) return false;
  try {
    return GENERIC_CANVAS_CLOUD_REST_HOSTS.has(new URL(n).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Resolve Canvas REST API base URL (scheme + host, no trailing slash).
 * Skips generic Instructure cloud iss hosts so school `canvasDomain` / custom fields are not overridden.
 * Order: canvasBaseUrl → canvasDomain → platformIss → env (each skipped if unusable generic cloud).
 */
export function resolveCanvasApiBaseUrl(input: {
  canvasBaseUrl?: string | null;
  canvasDomain?: string | null;
  platformIss?: string | null;
  /** Optional e.g. CANVAS_API_BASE_URL for non-LTI local scripts/tests */
  envFallback?: string | null;
}): string | undefined {
  const trim = (s?: string | null) => (typeof s === 'string' ? s.trim() : '') || undefined;

  const trySource = (raw: string | undefined | null): string | undefined => {
    const base = normalizeToCanvasRestBase(raw ?? undefined);
    if (!base) return undefined;
    if (isGenericCanvasCloudRestBase(base)) return undefined;
    return base;
  };

  const domainAsUrl = trim(input.canvasDomain);
  const domainCandidate = domainAsUrl
    ? domainAsUrl.startsWith('http://') || domainAsUrl.startsWith('https://')
      ? domainAsUrl
      : `https://${domainAsUrl}`
    : undefined;

  const sources: Array<string | undefined> = [
    trim(input.canvasBaseUrl),
    domainCandidate,
    trim(input.platformIss),
    trim(input.envFallback),
  ];

  for (const raw of sources) {
    const good = trySource(raw);
    if (good) return good;
  }

  return undefined;
}

/** Prefer LTI session fields; env is last resort. */
export function canvasApiBaseFromLtiContext(
  ctx: Partial<Pick<LtiContext, 'canvasBaseUrl' | 'canvasDomain' | 'platformIss'>>,
  envFallback?: string | null,
): string | undefined {
  return resolveCanvasApiBaseUrl({
    canvasBaseUrl: ctx.canvasBaseUrl,
    canvasDomain: ctx.canvasDomain,
    platformIss: ctx.platformIss,
    envFallback: envFallback ?? undefined,
  });
}

/**
 * When session still has only generic cloud `iss` as base, derive tenant from the browser Referer
 * (Canvas course UI URL). Safe: only runs if current resolved base is missing or generic cloud.
 */
export function repairCanvasHostFromRequest(req: Request): void {
  const session = req.session as { ltiContext?: LtiContext } | undefined;
  const ctx = session?.ltiContext;
  if (!ctx || !session) return;

  const current = resolveCanvasApiBaseUrl({
    canvasBaseUrl: ctx.canvasBaseUrl,
    canvasDomain: ctx.canvasDomain,
    platformIss: ctx.platformIss,
    envFallback: undefined,
  });
  if (current && !isGenericCanvasCloudRestBase(current)) return;

  const ref = req.get('referer')?.trim();
  if (!ref) return;

  let origin: string;
  try {
    const u = new URL(ref);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    origin = `${u.protocol}//${u.host}`;
  } catch {
    return;
  }

  if (isGenericCanvasCloudRestBase(origin)) return;

  const refHost = new URL(origin).hostname.toLowerCase();
  const apiHost = (req.get('host') ?? '').split(':')[0].toLowerCase();
  if (apiHost && refHost === apiHost) return;

  ctx.canvasBaseUrl = origin;
  ctx.canvasDomain = new URL(origin).hostname;
  appendLtiLog('lti', 'Repaired session Canvas REST host from Referer', {
    origin,
    path: req.path,
    hadGenericOrMissing: true,
  });
}
