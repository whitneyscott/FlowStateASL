/** SessionStorage key for LTI token so context can be restored after refresh. */
export const LTI_TOKEN_STORAGE_KEY = 'lti_token';

export function getStoredLtiToken(): string | null {
  try {
    return sessionStorage.getItem(LTI_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredLtiToken(token: string): void {
  try {
    sessionStorage.setItem(LTI_TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore
  }
}

/** Headers to add to API requests when we have a stored LTI token (for session restore on refresh). */
export function ltiTokenHeaders(): Record<string, string> {
  const token = getStoredLtiToken();
  if (!token) return {};
  return { 'X-LTI-Token': token };
}
