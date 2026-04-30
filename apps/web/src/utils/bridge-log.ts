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

/** Tags mirrored from server `appendLtiLog(scope, …)` for the Bridge debug panel. */
export const BRIDGE_LTI_LOG_SCOPES = [
  'webm-prompt',
  'sign-to-voice',
  'prompt-import-trace',
  /**
   * Teacher Prompt Manager: GET /api/prompt/config — assignment resolution, description embed parse,
   * text prompt counts (Canvas HTML vs. blob). Shown in Bridge; server always records these lines.
   */
  'prompt-manager-config',
  /** Student TimerPage: raw GET /config + classification (prompt mode / phase). */
  'student-prompt-type',
  /** Student deck live-build + hydrate (TimerPage). */
  'student-deck-live-build',
  /** Prompt image insertion/load diagnostics (RTE image picker + signed image auth). */
  'prompt-image-debug',
  /** Developer-only UX timing spans (teacher + student). */
  'ux-benchmark',
] as const;

export type BridgeLtiLogScope = (typeof BRIDGE_LTI_LOG_SCOPES)[number];

export function ltiLogLineMatchesBridgeFilter(line: string): boolean {
  return BRIDGE_LTI_LOG_SCOPES.some((scope) => line.includes(`] [${scope}] `));
}

/** Bridge log UI: WebM prompt metadata + sign-to-voice / Deepgram caption pipeline (server + client fallback). */
export function mergeBridgeLogLinesForDisplay(serverLines: string[], fallbackLines: string[]): string[] {
  return [...serverLines, ...fallbackLines].filter(ltiLogLineMatchesBridgeFilter);
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

/**
 * Tags that must log even when not in Developer app mode (e.g. student Timer / promptMode).
 * Otherwise students never hit appendBridgeLog and teachers see no lines in the server LTI buffer.
 */
/** Log + POST to /api/debug/lti-log even when `aslExpressAppMode` is not `developer` (student prompter, etc.). */
function shouldAlwaysBridgeLog(tag: string): boolean {
  return tag.startsWith('student-') || tag === 'prompt-manager-config' || tag === 'prompt-image-debug';
}

export function appendBridgeLog(tag: string, message: string, extra?: Record<string, unknown>): void {
  const fullMessage = `${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;

  if (shouldAlwaysBridgeLog(tag)) {
    try {
      console.info(`[ASL Bridge] [${tag}]`, message, extra ?? '');
    } catch {
      /* ignore */
    }
  } else if (!isBridgeClientDiagnosticsEnabled()) {
    return;
  }

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
      // Only mirror locally when the server did not record the line (avoids duplicate server + client lines in Bridge).
      appendClientFallbackLine(
        buildLine(
          tag,
          `${fullMessage} [client-fallback: failed to POST /api/debug/lti-log: ${String(err)}]`,
        ),
      );
    });
}
