import { appendBridgeLog } from './bridge-log';
import { readStoredAppMode } from './app-mode';

export type UxBenchmarkLevel = 'ok' | 'warn' | 'fail';

export interface UxBenchmarkBudget {
  targetMs: number;
  maxMs: number;
}

export interface UxBenchmarkSpanEndOptions {
  ok?: boolean;
  extra?: Record<string, unknown>;
}

export interface UxBenchmarkSpan {
  end: (opts?: UxBenchmarkSpanEndOptions) => void;
}

const DEFAULT_BUDGET: UxBenchmarkBudget = { targetMs: 3000, maxMs: 6000 };

function nowMs(): number {
  // `performance.now()` is monotonic; fall back for older environments.
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function isUxBenchmarkEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return readStoredAppMode() === 'developer';
}

function levelForDuration(durationMs: number, budget: UxBenchmarkBudget): UxBenchmarkLevel {
  if (durationMs > budget.maxMs) return 'fail';
  if (durationMs > budget.targetMs) return 'warn';
  return 'ok';
}

function tryConsoleLog(level: UxBenchmarkLevel, name: string, payload: Record<string, unknown>): void {
  try {
    const ms = typeof payload.durationMs === 'number' ? Math.round(payload.durationMs) : payload.durationMs;
    const prefix = level === 'fail' ? '[UX BENCH][FAIL]' : level === 'warn' ? '[UX BENCH][WARN]' : '[UX BENCH][OK]';
    // Keep a stable, greppable line with structured payload as the second argument.
    // eslint-disable-next-line no-console
    console.info(`${prefix} ${name} ${ms}ms`, payload);
  } catch {
    /* ignore */
  }
}

/**
 * Measure a user-blocking operation in developer mode.
 * Emits to Bridge log (tag `ux-benchmark`) and console.
 */
export function startUxSpan(
  name: string,
  meta?: Record<string, unknown>,
  budget: UxBenchmarkBudget = DEFAULT_BUDGET,
): UxBenchmarkSpan {
  if (!isUxBenchmarkEnabled()) {
    return { end: () => undefined };
  }
  const startedAt = nowMs();
  let ended = false;
  return {
    end: (opts?: UxBenchmarkSpanEndOptions) => {
      if (ended) return;
      ended = true;
      const durationMs = nowMs() - startedAt;
      const ok = opts?.ok !== false;
      const level = levelForDuration(durationMs, budget);
      const payload: Record<string, unknown> = {
        name,
        ok,
        level,
        durationMs,
        budget,
        ...(meta ?? {}),
        ...(opts?.extra ?? {}),
      };
      tryConsoleLog(level, name, payload);
      appendBridgeLog('ux-benchmark', `${level.toUpperCase()}: ${name}`, payload);
    },
  };
}

/** Convenience wrapper for async ops. */
export async function measureUxAsync<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
  budget: UxBenchmarkBudget = DEFAULT_BUDGET,
): Promise<T> {
  const span = startUxSpan(name, meta, budget);
  try {
    const out = await fn();
    span.end({ ok: true });
    return out;
  } catch (e) {
    span.end({ ok: false, extra: { error: e instanceof Error ? e.message : String(e) } });
    throw e;
  }
}

