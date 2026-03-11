const TTL_MS = 5 * 60 * 1000; // 5 minutes
const store = new Map<
  string,
  { nonce: string; redirectUri: string; targetLinkUri: string; expires: number }
>();

export function setOidcState(
  state: string,
  nonce: string,
  redirectUri: string,
  targetLinkUri: string
): void {
  store.set(state, {
    nonce,
    redirectUri,
    targetLinkUri,
    expires: Date.now() + TTL_MS,
  });
}

export function consumeOidcState(state: string): {
  nonce: string;
  redirectUri: string;
  targetLinkUri: string;
} | null {
  const entry = store.get(state);
  if (!entry || Date.now() > entry.expires) {
    store.delete(state);
    return null;
  }
  store.delete(state);
  return { nonce: entry.nonce, redirectUri: entry.redirectUri, targetLinkUri: entry.targetLinkUri };
}
