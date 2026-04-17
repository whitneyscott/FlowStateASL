let lastError: { endpoint: string; message: string; stack?: string } | null = null;
const ltiLog: string[] = [];
const MAX_LTI_LOG_LINES = 400;
let lastCanvasApiResponse: { status: number; statusText: string; bodyPreview: string } | null = null;

/** Bridge LTI log buffer keeps only `webm-prompt` unless explicitly disabled (build SHA from /api/debug/version). */
const BRIDGE_LOG_FOCUS_WEBM_TAGS = new Set(['webm-prompt']);

/**
 * Default **on**: only `webm-prompt` lines are stored in the in-memory LTI log (saves memory, matches Bridge UI).
 * Set `BRIDGE_LOG_FOCUS_WEBM=0` (or `false` / `no` / `off`) to retain all tags for deep debugging.
 */
export function isBridgeLogFocusWebmEnabled(): boolean {
  const v = (process.env.BRIDGE_LOG_FOCUS_WEBM ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

export type PlacementLtiVersion = '1.1' | '1.3' | 'unknown';
export type PlacementPath =
  | 'assignment_anchor'
  | 'deep_link_13'
  | 'template_clone_11'
  | 'manual_hybrid';
export type PlacementOutcome = 'ok' | 'fail' | 'skip' | 'warn';

export interface PlacementMarker {
  placementAttemptId: string;
  ltiVersion: PlacementLtiVersion;
  path: PlacementPath;
  marker: string;
  outcome: PlacementOutcome;
  reason?: string;
  canvasResponseCode?: number;
  assignmentId?: string;
  moduleId?: string;
}

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
  if (isBridgeLogFocusWebmEnabled() && !BRIDGE_LOG_FOCUS_WEBM_TAGS.has(tag)) {
    return;
  }
  const line = `[${new Date().toISOString()}] [${tag}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  ltiLog.push(line);
  while (ltiLog.length > MAX_LTI_LOG_LINES) ltiLog.shift();
  console.info(line);
}

export function appendPlacementMarker(marker: PlacementMarker): void {
  appendLtiLog('placement', marker.marker, marker as unknown as Record<string, unknown>);
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
