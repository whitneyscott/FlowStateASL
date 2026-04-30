import { useState, useEffect, useRef } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useAppMode } from '../contexts/AppModeContext';
import { ltiTokenHeaders } from '../api/lti-token';
import {
  BRIDGE_LTI_LOG_SCOPES,
  type BridgeLtiLogScope,
  clearBridgeClientFallbackLines,
  mergeBridgeLogLinesForDisplay,
  readBridgeClientFallbackLines,
} from '../utils/bridge-log';

interface BridgeLogProps {
  context: LtiContext | null;
  loading: boolean;
  error: string | null;
}

type DebugVersion = {
  apiSha?: string;
  apiBranch?: string;
  nodeEnv?: string;
};

export function BridgeLog({ context, loading, error }: BridgeLogProps) {
  const { isDeveloperMode } = useAppMode();
  const isTeacherRole =
    /instructor|administrator|faculty|teacher|staff|contentdeveloper|teachingassistant|ta/i.test(
      context?.roles || '',
    );
  /**
   * Bridge log only in password-gated Developer app mode. Demo and Production never show it — not even with
   * ?debug=1 (that query previously bypassed the mode switch and confused “Production mode”).
   */
  const developerUi = isTeacherRole && isDeveloperMode;
  const canClearLog = isDeveloperMode;
  const [ltiLog, setLtiLog] = useState<string[]>([]);
  const [debugVersion, setDebugVersion] = useState<DebugVersion | null>(null);
  const [lines, setLines] = useState<string[]>(['Initializing...']);
  const containerRef = useRef<HTMLDivElement>(null);

  const FILTER_STORAGE_KEY = 'fs_bridge_visible_tags_v1';
  const FILTER_QUERY_STORAGE_KEY = 'fs_bridge_filter_query_v1';
  const FILTER_ONLY_WARN_ERROR_STORAGE_KEY = 'fs_bridge_filter_warn_error_only_v1';
  const DEFAULT_VISIBLE_TAGS: BridgeLtiLogScope[] = [
    'prompt-manager-config',
    'ux-benchmark',
    'prompt-image-debug',
    'prompt-import-trace',
    'student-prompt-type',
    'student-deck-live-build',
  ];
  const [visibleTags, setVisibleTags] = useState<BridgeLtiLogScope[]>(DEFAULT_VISIBLE_TAGS);
  const [showFilters, setShowFilters] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [onlyWarnError, setOnlyWarnError] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const next = parsed.filter((t): t is BridgeLtiLogScope =>
        BRIDGE_LTI_LOG_SCOPES.includes(t as BridgeLtiLogScope),
      );
      if (next.length) setVisibleTags(next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(visibleTags));
    } catch {
      // ignore
    }
  }, [visibleTags]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const rawQuery = window.localStorage.getItem(FILTER_QUERY_STORAGE_KEY);
      if (rawQuery != null) setFilterQuery(rawQuery);
      const rawOnly = window.localStorage.getItem(FILTER_ONLY_WARN_ERROR_STORAGE_KEY);
      if (rawOnly === '1') setOnlyWarnError(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(FILTER_QUERY_STORAGE_KEY, filterQuery);
      window.localStorage.setItem(FILTER_ONLY_WARN_ERROR_STORAGE_KEY, onlyWarnError ? '1' : '0');
    } catch {
      // ignore
    }
  }, [filterQuery, onlyWarnError]);

  const isTagVisible = (tag: BridgeLtiLogScope): boolean => visibleTags.includes(tag);

  const applyLineFilters = (input: string[]): string[] => {
    const q = filterQuery.trim().toLowerCase();
    const filteredByQuery = q ? input.filter((l) => l.toLowerCase().includes(q)) : input;
    if (!onlyWarnError) return filteredByQuery;

    // Heuristic: keep lines that look like warn/error/failure signals across tags.
    const re = /\b(warn|warning|fail|failed|error|err)\b/i;
    return filteredByQuery.filter((l) => re.test(l));
  };

  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (developerUi) {
      setExpanded(true);
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [developerUi]);

  useEffect(() => {
    if (!developerUi) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [ltiRes, versionRes] = await Promise.all([
          fetch('/api/debug/lti-log', { credentials: 'include', headers: ltiTokenHeaders() }),
          fetch('/api/debug/version', { credentials: 'include', headers: ltiTokenHeaders() }),
        ]);
        if (cancelled) return;
        const [ltiData, versionData] = await Promise.all([
          ltiRes.json().catch(() => null),
          versionRes.json().catch(() => null),
        ]);
        const serverLines = Array.isArray(ltiData?.lines) ? ltiData.lines : [];
        const fallbackLines = readBridgeClientFallbackLines();
        setDebugVersion(versionData ?? null);
        setLtiLog(mergeBridgeLogLinesForDisplay(serverLines, fallbackLines));
      } catch {
        if (!cancelled) {
          setDebugVersion(null);
          setLtiLog(mergeBridgeLogLinesForDisplay([], readBridgeClientFallbackLines()));
        }
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [developerUi]);
  const [copied, setCopied] = useState(false);
  const [clearingAuth, setClearingAuth] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  useEffect(() => {
    const newLines: string[] = [];
    const shortSha = (v: string | undefined): string => {
      const s = String(v ?? '').trim();
      if (!s || s.toLowerCase() === 'unknown') return 'unknown';
      return s.slice(0, 7);
    };
    const webSha = shortSha(typeof __WEB_BUILD_SHA__ === 'string' ? __WEB_BUILD_SHA__ : undefined);
    const apiSha = shortSha(debugVersion?.apiSha);
    const apiBranch = String(debugVersion?.apiBranch ?? 'unknown').trim() || 'unknown';
    const nodeEnv = String(debugVersion?.nodeEnv ?? 'unknown').trim() || 'unknown';
    newLines.push('--- Build Fingerprint ---');
    newLines.push(`web=${webSha} api=${apiSha} branch=${apiBranch} env=${nodeEnv}`);
    newLines.push('');
    if (isTagVisible('webm-prompt')) {
      newLines.push('--- WebM prompt (tag webm-prompt) ---');
      const wm = applyLineFilters(ltiLog.filter((line) => line.includes('] [webm-prompt] ')));
      if (wm.length === 0) {
        newLines.push(
          filterQuery.trim() || onlyWarnError
            ? '(no matching webm-prompt lines for current filters)'
            : '(no webm-prompt lines yet — submit a WebM, open grading/submissions, or GET /api/debug/ping)',
        );
      } else {
        newLines.push(...wm);
      }
      newLines.push('');
    }

    if (isTagVisible('sign-to-voice')) {
      newLines.push('--- Sign-to-voice / Deepgram captions (tag sign-to-voice) ---');
      const stv = applyLineFilters(ltiLog.filter((line) => line.includes('] [sign-to-voice] ')));
      if (stv.length === 0) {
        newLines.push(
          filterQuery.trim() || onlyWarnError
            ? '(no matching sign-to-voice lines for current filters)'
            : '(no sign-to-voice log lines yet — this panel only shows server events. After Save in Prompt Manager and a student upload, lines appear here; if the pipeline was skipped, look for SKIPPED or resolveSignToVoiceRequired.)',
        );
      } else {
        newLines.push(...stv);
      }
      newLines.push('');
    }

    if (isTagVisible('prompt-import-trace')) {
      newLines.push('--- Prompt import trace (tag prompt-import-trace) ---');
      const pit = applyLineFilters(ltiLog.filter((line) => line.includes('] [prompt-import-trace] ')));
      if (pit.length === 0) {
        newLines.push(
          filterQuery.trim() || onlyWarnError
            ? '(no matching prompt-import-trace lines for current filters)'
            : '(no prompt-import-trace lines yet — run single-assignment import in Teacher Config to trace the import POST)',
        );
      } else {
        newLines.push(...pit);
      }
      newLines.push('');
    }

    if (isTagVisible('prompt-manager-config')) {
      newLines.push('--- Teacher Prompt Manager / GET /config (tag prompt-manager-config) ---');
      const pmc = applyLineFilters(ltiLog.filter((line) => line.includes('] [prompt-manager-config] ')));
      if (pmc.length === 0) {
        newLines.push(
          filterQuery.trim() || onlyWarnError
            ? '(no matching prompt-manager-config lines for current filters)'
            : '(no prompt-manager-config yet — open Prompt Manager /config, pick an assignment, or look for readPromptConfig + getConfig lines on the server after GET /config)',
        );
      } else {
        newLines.push(...pmc);
      }
      newLines.push('');
    }

    if (isTagVisible('prompt-image-debug')) {
      newLines.push('--- Prompt image diagnostics (tag prompt-image-debug) ---');
      const pidRaw = ltiLog.filter((line) => line.includes('] [prompt-image-debug] '));
      const pid = applyLineFilters(pidRaw);
      if (pid.length === 0) {
        newLines.push(
          filterQuery.trim() || onlyWarnError
            ? '(no matching prompt-image-debug lines for current filters)'
            : '(no prompt-image-debug lines yet — try Insert image (upload or pick), then check for pickFile/upload, signed-path, guard-check, stream, and RTE image load lines)',
        );
      } else {
        newLines.push(...pid);
      }
      newLines.push('');
      newLines.push('--- Prompt image diagnostics raw tail (last 25) ---');
      if (pid.length === 0) {
        newLines.push('(raw tail empty)');
      } else {
        newLines.push(...pid.slice(-25));
      }
      newLines.push('');
    }

    if (isTagVisible('student-prompt-type')) {
      newLines.push('--- Student prompt mode / Timer (tag student-prompt-type) ---');
      const spt = applyLineFilters(ltiLog.filter((line) => line.includes('] [student-prompt-type] ')));
      if (spt.length === 0) {
        newLines.push(
          filterQuery.trim() || onlyWarnError
            ? '(no matching student-prompt-type lines for current filters)'
            : '(no student-prompt-type lines yet — open the student prompter/Timer; lines also go to the browser console as [ASL Bridge])',
        );
      } else {
        newLines.push(...spt);
      }
      newLines.push('');
    }

    if (isTagVisible('student-deck-live-build')) {
      newLines.push('--- Student deck live build (tag student-deck-live-build) ---');
      const sdl = applyLineFilters(ltiLog.filter((line) => line.includes('] [student-deck-live-build] ')));
      if (sdl.length === 0) {
        newLines.push(
          filterQuery.trim() || onlyWarnError
            ? '(no matching student-deck-live-build lines for current filters)'
            : '(no student-deck-live-build lines yet — deck mode POST /build-deck-prompts; console: [ASL Bridge])',
        );
      } else {
        newLines.push(...sdl);
      }
      newLines.push('');
    }

    if (isTagVisible('ux-benchmark')) {
      newLines.push('--- UX benchmarking (tag ux-benchmark) ---');
      const uxb = applyLineFilters(ltiLog.filter((line) => line.includes('] [ux-benchmark] ')));
      if (uxb.length === 0) {
        newLines.push(
          filterQuery.trim() || onlyWarnError
            ? '(no matching ux-benchmark lines for current filters)'
            : '(no ux-benchmark lines yet — switch to Developer mode, then load Prompt Settings / Timer / Flashcards. Lines also go to the browser console as [UX BENCH].)',
        );
      } else {
        newLines.push(...uxb.slice(-80));
      }
    }
    setLines(newLines);
  }, [ltiLog, debugVersion, visibleTags, filterQuery, onlyWarnError]);

  const text = ['BRIDGE DEBUG LOG:', ...lines].join('\n');

  if (!developerUi) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      style={{
        background: '#000',
        color: '#00ff88',
        fontFamily: 'monospace',
        padding: 12,
        border: '2px solid #00ff88',
        margin: '10px auto 20px auto',
        textAlign: 'left',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
        overflow: 'auto',
        fontSize: 13,
        lineHeight: 1.4,
        maxWidth: 800,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: expanded ? 4 : 0,
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          style={{
            background: 'none',
            border: 'none',
            color: '#00ff88',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 'inherit',
            fontWeight: 'bold',
            padding: 0,
          }}
        >
          {expanded ? '▼' : '▶'} BRIDGE DEBUG LOG
        </button>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            style={{
              background: 'none',
              border: '1px solid #00ff88',
              color: '#00ff88',
              padding: '4px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 11,
            }}
            title="Choose which tagged sections to show"
          >
            {showFilters ? 'Hide filters' : 'Filters'}
          </button>
        <button
          type="button"
          disabled={!canClearLog}
          onClick={async () => {
            if (!canClearLog) return;
            await fetch('/api/debug/lti-log?clear=1', { credentials: 'include', headers: ltiTokenHeaders() });
            clearBridgeClientFallbackLines();
            setLtiLog([]);
          }}
          title={canClearLog ? 'Clear LTI log' : 'Clear disabled outside developer/debug mode'}
          style={{
            background: 'none',
            border: '1px solid #00ff88',
            color: '#00ff88',
            padding: '4px 8px',
            borderRadius: 4,
            cursor: canClearLog ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            fontSize: 11,
            marginRight: 8,
            opacity: canClearLog ? 1 : 0.55,
          }}
        >
          Clear LTI log {canClearLog ? '' : '(dev only)'}
        </button>
        <button
          type="button"
          disabled={clearingAuth}
          onClick={async () => {
            setClearingAuth(true);
            try {
              const res = await fetch('/api/oauth/canvas/token/reset', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', ...ltiTokenHeaders() },
              });
              if (!res.ok) {
                // Fallback for dev when oauth reset endpoint rejects due missing LTI context.
                const debugReset = await fetch('/api/debug/clear-canvas-auth', {
                  method: 'POST',
                  credentials: 'include',
                  headers: ltiTokenHeaders(),
                });
                if (!debugReset.ok) {
                  const t = await res.text();
                  window.alert(`Could not reset Canvas token: ${res.status} ${t.slice(0, 200)}`);
                  return;
                }
              }
              window.dispatchEvent(new CustomEvent('aslexpress:canvas-token-cleared'));
            } catch (e) {
              window.alert(e instanceof Error ? e.message : 'Request failed');
            } finally {
              setClearingAuth(false);
            }
          }}
          title="Resets OAuth/manual Canvas token from session and prompts for re-entry."
          style={{
            background: '#553300',
            border: '1px solid #ffaa00',
            color: '#ffcc66',
            padding: '4px 8px',
            borderRadius: 4,
            cursor: clearingAuth ? 'wait' : 'pointer',
            fontFamily: 'inherit',
            fontSize: 11,
            marginRight: 8,
            opacity: clearingAuth ? 0.7 : 1,
          }}
        >
          {clearingAuth ? 'Clearing…' : 'Clear Canvas token'}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            background: '#00ff88',
            color: '#000',
            border: 'none',
            padding: '4px 10px',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 'bold',
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        </div>
      </div>
      {expanded && showFilters && (
        <div style={{ border: '1px solid #00ff88', padding: 8, borderRadius: 6, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#00ff88' }}>
              <span style={{ color: '#66ffaa' }}>Search</span>
              <input
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="e.g. userId:427535"
                style={{
                  background: '#000',
                  color: '#00ff88',
                  border: '1px solid #00ff88',
                  borderRadius: 4,
                  padding: '3px 6px',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  width: 220,
                }}
              />
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#00ff88' }}>
              <input
                type="checkbox"
                checked={onlyWarnError}
                onChange={(e) => setOnlyWarnError(e.target.checked)}
              />
              <span>Only warn/error</span>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => setVisibleTags([...BRIDGE_LTI_LOG_SCOPES])}
              style={{ background: 'none', border: '1px solid #00ff88', color: '#00ff88', padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setVisibleTags([])}
              style={{ background: 'none', border: '1px solid #00ff88', color: '#00ff88', padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}
            >
              None
            </button>
            <button
              type="button"
              onClick={() => setVisibleTags(DEFAULT_VISIBLE_TAGS)}
              style={{ background: 'none', border: '1px solid #00ff88', color: '#00ff88', padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterQuery('');
                setOnlyWarnError(false);
              }}
              style={{ background: 'none', border: '1px solid #00ff88', color: '#00ff88', padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}
              title="Clear search + warn/error toggle"
            >
              Clear text
            </button>
            <span style={{ color: '#66ffaa', fontSize: 11 }}>
              Showing {visibleTags.length}/{BRIDGE_LTI_LOG_SCOPES.length}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {BRIDGE_LTI_LOG_SCOPES.map((tag) => (
              <label key={tag} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#00ff88' }}>
                <input
                  type="checkbox"
                  checked={visibleTags.includes(tag)}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setVisibleTags((prev) => (checked ? Array.from(new Set([...prev, tag])) : prev.filter((t) => t !== tag)));
                  }}
                />
                <span>{tag}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {expanded && <div>{text.split('\n').slice(1).join('\n')}</div>}
    </div>
  );
}
