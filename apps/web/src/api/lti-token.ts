let inMemoryAuthToken = '';

export function getAuthToken(): string {
  return inMemoryAuthToken;
}

export function setAuthToken(token: string): void {
  inMemoryAuthToken = (token ?? '').trim();
}

export function clearAuthToken(): void {
  inMemoryAuthToken = '';
}

/** Authorization header from in-memory auth token only (never persisted). */
export function ltiTokenHeaders(): Record<string, string> {
  const token = getAuthToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
