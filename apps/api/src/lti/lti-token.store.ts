import type { LtiContext } from '../common/interfaces/lti-context.interface';

const TTL_MS = 60_000;
const store = new Map<
  string,
  { ctx: LtiContext; expires: number }
>();

export function setLtiToken(token: string, ctx: LtiContext): void {
  store.set(token, { ctx, expires: Date.now() + TTL_MS });
}

export function consumeLtiToken(token: string): LtiContext | null {
  const entry = store.get(token);
  if (!entry || Date.now() > entry.expires) {
    store.delete(token);
    return null;
  }
  store.delete(token);
  return entry.ctx;
}
