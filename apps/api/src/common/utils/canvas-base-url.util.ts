import type { LtiContext } from '../interfaces/lti-context.interface';

/**
 * Resolve Canvas REST API base URL (scheme + host, no trailing slash).
 * Order: explicit canvasBaseUrl → LTI issuer (platformIss) → canvasDomain → optional env (local/dev only).
 */
export function resolveCanvasApiBaseUrl(input: {
  canvasBaseUrl?: string | null;
  canvasDomain?: string | null;
  platformIss?: string | null;
  /** Optional e.g. CANVAS_API_BASE_URL for non-LTI local scripts/tests */
  envFallback?: string | null;
}): string | undefined {
  const trim = (s?: string | null) => (typeof s === 'string' ? s.trim() : '') || undefined;

  let candidate = trim(input.canvasBaseUrl);
  if (!candidate && input.platformIss) {
    try {
      const u = new URL(input.platformIss.trim());
      candidate = `${u.protocol}//${u.host}`;
    } catch {
      // ignore invalid iss
    }
  }
  if (!candidate && input.canvasDomain) {
    const d = trim(input.canvasDomain);
    if (d) {
      candidate = d.startsWith('http://') || d.startsWith('https://') ? d : `https://${d}`;
    }
  }
  const env = trim(input.envFallback);
  if (!candidate) candidate = env;
  if (!candidate) return undefined;

  try {
    const normalized =
      candidate.startsWith('http://') || candidate.startsWith('https://')
        ? candidate
        : `https://${candidate}`;
    const u = new URL(normalized);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
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
