import { ltiTokenHeaders } from '../api/lti-token';
import { APP_MODE_STORAGE_KEY } from './app-mode';

const CLIENT_FALLBACK_KEY = 'aslexpress_bridge_log_client_fallback_v1';
const MAX_CLIENT_FALLBACK_LINES = 120;

function buildLine(tag: string, message: string): string {
  return `[${new Date().toISOString()}] [${tag}] ${message}`;
}

function readClientFallbackStore(): string[] {
  try {
    const raw = localStorage.getItem(CLIENT_FALLBACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((line): line is string => typeof line === 'string');
  } catch {
    return [];
  }
}

function writeClientFallbackStore(lines: string[]): void {
  try {
    localStorage.setItem(CLIENT_FALLBACK_KEY, JSON.stringify(lines.slice(-MAX_CLIENT_FALLBACK_LINES)));
  } catch {
    // best effort diagnostics only
  }
}

function appendClientFallbackLine(line: string): void {
  const current = readClientFallbackStore();
  current.push(line);
  writeClientFallbackStore(current);
}

export function readBridgeClientFallbackLines(): string[] {
  return readClientFallbackStore();
}

/** Bridge log UI filters to `[webm-prompt]` lines from server + client fallback (full LTI log still on server). */
export function mergeBridgeLogLinesForDisplay(serverLines: string[], fallbackLines: string[]): string[] {
  return [...serverLines, ...fallbackLines].filter((l) => l.includes('] [webm-prompt] '));
}

export function clearBridgeClientFallbackLines(): void {
  try {
    localStorage.removeItem(CLIENT_FALLBACK_KEY);
  } catch {
    // best effort diagnostics only
  }
}

/** Same policy as BridgeLog UI: only Developer app mode (localStorage; Prompt Manager + Flashcards). */
function isBridgeClientDiagnosticsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const v = localStorage.getItem(APP_MODE_STORAGE_KEY);
    return v === 'developer';
  } catch {
    return false;
  }
}

export function appendBridgeLog(tag: string, message: string, extra?: Record<string, unknown>): void {
  if (!isBridgeClientDiagnosticsEnabled()) return;

  const fullMessage = `${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  // Always keep a local mirror so BridgeLog remains useful even if backend logs are on another instance/process.
  appendClientFallbackLine(buildLine(tag, `${fullMessage} [client-mirror]`));
  void fetch('/api/debug/lti-log', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...ltiTokenHeaders() },
    body: JSON.stringify({ tag, message: fullMessage }),
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    })
    .catch((err) => {
      appendClientFallbackLine(
        buildLine(
          tag,
          `${fullMessage} [client-fallback: failed to POST /api/debug/lti-log: ${String(err)}]`,
        ),
      );
    });
}
