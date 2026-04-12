import { Request } from 'express';

/**
 * Derive the public origin from the request when behind a reverse proxy.
 * Priority:
 * 1) x-forwarded-host + x-forwarded-proto
 * 2) host + x-forwarded-proto
 * 3) req.hostname + req.protocol
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
  const hostHeader = firstHeaderValue('host');
  const reqHost = (req.hostname || '').trim();

  const host = forwardedHost || hostHeader || reqHost;
  if (!host) return '';

  const proto = normalizeScheme(firstHeaderValue('x-forwarded-proto') || req.protocol || 'https');
  return `${proto}://${host}`.replace(/\/$/, '');
}
