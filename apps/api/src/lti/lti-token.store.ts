import type { LtiContext } from '../common/interfaces/lti-context.interface';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — frontend must call /api/lti/context within this window to set session
const store = new Map<
  string,
  { ctx: LtiContext; expires: number }
>();

export function setLtiToken(token: string, ctx: LtiContext): void {
  store.set(token, { ctx, expires: Date.now() + TTL_MS });
}

/** Returns context without deleting the token so it can be reused on refresh. */
export function getLtiToken(token: string): LtiContext | null {
  const entry = store.get(token);
  if (!entry || Date.now() > entry.expires) {
    if (entry) store.delete(token);
    return null;
  }
  return entry.ctx;
}

export function consumeLtiToken(token: string): LtiContext | null {
  const ctx = getLtiToken(token);
  if (ctx) store.delete(token);
  return ctx;
}
