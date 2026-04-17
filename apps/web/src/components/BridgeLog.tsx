import { useState, useEffect, useRef } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useAppMode } from '../contexts/AppModeContext';
import { ltiTokenHeaders } from '../api/lti-token';
import {
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
    newLines.push('--- WebM prompt (tag webm-prompt only) ---');
    const wm = ltiLog.filter((line) => line.includes('] [webm-prompt] '));
    if (wm.length === 0) {
      newLines.push(
        '(no webm-prompt lines yet — submit a WebM, open grading/submissions, or GET /api/debug/ping)',
      );
    } else {
      newLines.push(...wm);
    }
    setLines(newLines);
  }, [ltiLog, debugVersion]);

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
      {expanded && <div>{text.split('\n').slice(1).join('\n')}</div>}
    </div>
  );
}
