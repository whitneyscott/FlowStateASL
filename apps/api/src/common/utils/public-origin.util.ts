import { Request } from 'express';

/**
 * Derive the public origin from the request when behind a reverse proxy.
 * Uses x-forwarded-host/x-forwarded-proto if present; otherwise returns ''
 * so callers fall back to LTI_REDIRECT_URI / FRONTEND_URL from .env.
 */
export function getPublicOrigin(req: Request): string {
  const fwdHost = (req.get('x-forwarded-host') || '').trim();
  if (!fwdHost) return '';

  const host = fwdHost.split(',')[0].trim();
  const proto = (req.get('x-forwarded-proto') || 'https').trim().toLowerCase();
  const scheme = proto === 'https' || proto === 'http' ? proto : 'https';
  return `${scheme}://${host}`.replace(/\/$/, '');
}
