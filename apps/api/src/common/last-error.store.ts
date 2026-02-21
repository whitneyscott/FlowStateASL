let lastError: { endpoint: string; message: string; stack?: string } | null = null;

export function setLastError(endpoint: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  lastError = { endpoint, message, stack };
  console.error(`[${endpoint}]`, message, stack ?? '');
}

export function getLastError(): { endpoint: string; message: string } | null {
  if (!lastError) return null;
  return { endpoint: lastError.endpoint, message: lastError.message };
}
