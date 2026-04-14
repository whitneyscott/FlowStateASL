import { ltiTokenHeaders } from '../api/lti-token';

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

export function clearBridgeClientFallbackLines(): void {
  try {
    localStorage.removeItem(CLIENT_FALLBACK_KEY);
  } catch {
    // best effort diagnostics only
  }
}

export function appendBridgeLog(tag: string, message: string, extra?: Record<string, unknown>): void {
  const fullMessage = `${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
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
