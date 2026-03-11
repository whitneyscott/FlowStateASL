let lastError: { endpoint: string; message: string; stack?: string } | null = null;
const ltiLog: string[] = [];
let lastCanvasApiResponse: { status: number; statusText: string; bodyPreview: string } | null = null;

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

export function appendLtiLog(tag: string, message: string, extra?: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  ltiLog.push(line);
  if (ltiLog.length > 50) ltiLog.shift();
}

export function getLtiLog(): string[] {
  return [...ltiLog];
}

export function clearLtiLog(): void {
  ltiLog.length = 0;
}

export function setLastCanvasApiResponse(r: { status: number; statusText: string; bodyPreview: string } | null): void {
  lastCanvasApiResponse = r;
}

export function getLastCanvasApiResponse(): { status: number; statusText: string; bodyPreview: string } | null {
  return lastCanvasApiResponse;
}
