import type { LtiContext } from '../interfaces/lti-context.interface';
import type { Request } from 'express';
import { appendLtiLog } from '../last-error.store';

/**
 * Instructure-operated Canvas hosts (JWT `iss` is often this — not a school subdomain).
 * We still use these as REST base when Canvas explicitly gives them (return_url, FFT, etc.).
 * We avoid using *only* unqualified `iss` for schools that run on *.instructure.com subdomains.
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

/**
 * Turn Canvas LTI strings (custom fields, launch_presentation.return_url) into API origin (scheme + host).
 * Supports full URLs, protocol-relative, host-only, and path-only paths resolved against JWT `iss` when needed.
 */
export function resolveCanvasLaunchUrlToRestBase(
  raw: string | null | undefined,
  issForRelative?: string | null,
): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return undefined;
  try {
    if (s.startsWith('http://') || s.startsWith('https://')) {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
      return `${u.protocol}//${u.host}`;
    }
    if (s.startsWith('//')) {
      const u = new URL(`https:${s}`);
      if (u.protocol !== 'https:') return undefined;
      return `${u.protocol}//${u.host}`;
    }
    if (s.startsWith('/')) {
      const issBase = normalizeToCanvasRestBase(issForRelative ?? undefined);
      if (!issBase) return undefined;
      const u = new URL(s, issBase.endsWith('/') ? issBase : `${issBase}/`);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
      return `${u.protocol}//${u.host}`;
    }
    const u = new URL(`https://${s}`);
    if (u.protocol !== 'https:') return undefined;
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
 * Order: canvasBaseUrl → canvasDomain → platformIss → env.
 * Explicit session/env values trust Canvas (including Free-for-Teacher `canvas.instructure.com`).
 * `platformIss` alone skips generic cloud so a school subdomain is not replaced by the global platform id.
 */
export function resolveCanvasApiBaseUrl(input: {
  canvasBaseUrl?: string | null;
  canvasDomain?: string | null;
  platformIss?: string | null;
  /** Optional e.g. CANVAS_API_BASE_URL for non-LTI local scripts/tests */
  envFallback?: string | null;
}): string | undefined {
  const trim = (s?: string | null) => (typeof s === 'string' ? s.trim() : '') || undefined;

  /** From LTI/session: accept any normalizable host, including Instructure cloud (FFT). */
  const tryExplicitSource = (raw: string | undefined | null): string | undefined => {
    const base = normalizeToCanvasRestBase(raw ?? undefined);
    if (!base) return undefined;
    return base;
  };

  /** JWT `iss` only: reject generic cloud so school tenants can fall through to return_url / Referer. */
  const tryPlatformIss = (raw: string | undefined | null): string | undefined => {
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

  const explicitChain: Array<string | undefined> = [trim(input.canvasBaseUrl), domainCandidate];
  for (const raw of explicitChain) {
    const good = tryExplicitSource(raw);
    if (good) return good;
  }

  const fromIss = tryPlatformIss(trim(input.platformIss));
  if (fromIss) return fromIss;

  return tryExplicitSource(trim(input.envFallback));
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
  if (current) return;

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
