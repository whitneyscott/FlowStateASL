import { Request } from 'express';

/**
 * RFC 7239 `Forwarded` — first hop, host parameter (some proxies send this instead of X-Forwarded-Host).
 */
function hostFromForwardedHeader(req: Request): string {
  const raw = (req.get('forwarded') || '').trim();
  if (!raw) return '';
  const first = (raw.split(',')[0] || '').trim();
  const m = /\bhost\s*=\s*(?:"([^"]+)"|([^;,\s]+))/i.exec(first);
  const cap = m?.[1] ?? m?.[2];
  return cap ? cap.trim() : '';
}

function protoFromForwardedHeader(req: Request): string {
  const raw = (req.get('forwarded') || '').trim();
  if (!raw) return '';
  const first = (raw.split(',')[0] || '').trim();
  const m = /\bproto\s*=\s*(?:"([^"]+)"|([^;,\s]+))/i.exec(first);
  const cap = m?.[1] ?? m?.[2];
  return cap ? cap.trim().toLowerCase() : '';
}

/**
 * Derive the public origin from the incoming request (reverse-proxy safe).
 * Does not use FRONTEND_URL — callers may still fall back to env if this returns '' in production.
 *
 * Priority:
 * 1) x-forwarded-host (+ x-forwarded-proto or Forwarded proto or req.protocol)
 * 2) RFC 7239 Forwarded `host=` (+ proto from same header when present)
 * 3) Host header
 * 4) req.hostname (Express)
 * 5) Non-production only: `localhost` if all of the above are missing (avoids empty origin in local dev)
 */
export function getPublicOrigin(req: Request): string {
  const firstHeaderValue = (name: string): string => {
    const raw = (req.get(name) || '').trim();
    if (!raw) return '';
    return raw.split(',')[0].trim();
  };

  const normalizeScheme = (value: string): 'http' | 'https' => {
    const v = (value || '').trim().toLowerCase();
    return v === 'http' ? 'http' : 'https';
  };

  const forwardedHost = firstHeaderValue('x-forwarded-host');
  const rfcForwardedHost = hostFromForwardedHeader(req);
  const hostHeader = firstHeaderValue('host');
  const reqHost = (req.hostname || '').trim();

  let host = forwardedHost || rfcForwardedHost || hostHeader || reqHost;
  if (!host && process.env.NODE_ENV !== 'production') {
    host = 'localhost';
  }
  if (!host) return '';

  const forwardedProto = protoFromForwardedHeader(req);
  const proto = normalizeScheme(
    firstHeaderValue('x-forwarded-proto') || forwardedProto || req.protocol || 'https',
  );
  return `${proto}://${host}`.replace(/\/$/, '');
}
