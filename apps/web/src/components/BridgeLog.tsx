import { useState, useEffect, useRef } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useAppMode } from '../contexts/AppModeContext';
import { ltiTokenHeaders } from '../api/lti-token';
import { readStudentBridgeEnabled } from '../utils/app-mode';
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
  const [studentBridge, setStudentBridge] = useState(() => readStudentBridgeEnabled());
  useEffect(() => {
    const sync = () => setStudentBridge(readStudentBridgeEnabled());
    window.addEventListener('aslexpress:student-bridge-changed', sync);
    return () => window.removeEventListener('aslexpress:student-bridge-changed', sync);
  }, []);
  /**
   * Teachers: Developer app mode. Support flow (AppRouter) sets `aslExpressStudentBridge` for students
   * so Demo/Production can show the same panel.
   */
  const showBridgeLogUi = (isTeacherRole && isDeveloperMode) || studentBridge;
  const canClearLog = isDeveloperMode;
  const [ltiLog, setLtiLog] = useState<string[]>([]);
  const [debugVersion, setDebugVersion] = useState<DebugVersion | null>(null);
  const [lines, setLines] = useState<string[]>(['Initializing...']);
  const containerRef = useRef<HTMLDivElement>(null);

  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (showBridgeLogUi) {
      setExpanded(true);
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showBridgeLogUi]);

  useEffect(() => {
    if (!showBridgeLogUi) return;
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
  }, [showBridgeLogUi]);
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
    newLines.push('--- WebM prompt (tag webm-prompt) ---');
    const wm = ltiLog.filter((line) => line.includes('] [webm-prompt] '));
    if (wm.length === 0) {
      newLines.push(
        '(no webm-prompt lines yet — submit a WebM, open grading/submissions, or GET /api/debug/ping)',
      );
    } else {
      newLines.push(...wm);
    }
    newLines.push('');
    newLines.push('--- Sign-to-voice / Deepgram captions (tag sign-to-voice) ---');
    const stv = ltiLog.filter((line) => line.includes('] [sign-to-voice] '));
    if (stv.length === 0) {
      newLines.push(
        '(no sign-to-voice log lines yet — this panel only shows server events. After Save in Prompt Manager and a student upload, lines appear here; if the pipeline was skipped, look for SKIPPED or resolveSignToVoiceRequired.)',
      );
    } else {
      newLines.push(...stv);
    }
    newLines.push('');
    newLines.push('--- Prompt import trace (tag prompt-import-trace) ---');
    const pit = ltiLog.filter((line) => line.includes('] [prompt-import-trace] '));
    if (pit.length === 0) {
      newLines.push(
        '(no prompt-import-trace lines yet — run single-assignment import in Teacher Config to trace the import POST)',
      );
    } else {
      newLines.push(...pit);
    }
    newLines.push('');
    newLines.push('--- Teacher Prompt Manager / GET /config (tag prompt-manager-config) ---');
    const pmc = ltiLog.filter((line) => line.includes('] [prompt-manager-config] '));
    if (pmc.length === 0) {
      newLines.push(
        '(no prompt-manager-config yet — open Prompt Manager /config, pick an assignment, or look for readPromptConfig + getConfig lines on the server after GET /config)',
      );
    } else {
      newLines.push(...pmc);
    }
    newLines.push('');
    newLines.push('--- Prompt image diagnostics (tag prompt-image-debug) ---');
    const pid = ltiLog.filter((line) => line.includes('] [prompt-image-debug] '));
    if (pid.length === 0) {
      newLines.push(
        '(no prompt-image-debug lines yet — try Insert image (upload or pick), then check for pickFile/upload, signed-path, guard-check, stream, and RTE image load lines)',
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
    newLines.push('--- Student prompt mode / Timer (tag student-prompt-type) ---');
    const spt = ltiLog.filter((line) => line.includes('] [student-prompt-type] '));
    if (spt.length === 0) {
      newLines.push(
        '(no student-prompt-type lines yet — open the student prompter/Timer; lines also go to the browser console as [ASL Bridge])',
      );
    } else {
      newLines.push(...spt);
    }
    newLines.push('');
    newLines.push('--- Student deck live build (tag student-deck-live-build) ---');
    const sdl = ltiLog.filter((line) => line.includes('] [student-deck-live-build] '));
    if (sdl.length === 0) {
      newLines.push(
        '(no student-deck-live-build lines yet — deck mode POST /build-deck-prompts; console: [ASL Bridge])',
      );
    } else {
      newLines.push(...sdl);
    }
    newLines.push('');
    newLines.push('--- UX benchmarking (tag ux-benchmark) ---');
    const uxb = ltiLog.filter((line) => line.includes('] [ux-benchmark] '));
    if (uxb.length === 0) {
      newLines.push(
        '(no ux-benchmark lines yet — open Timer / Flashcards / Prompt Settings; spans record in all app modes and post here. [UX BENCH] console only in Developer mode on teachers.)',
      );
    } else {
      newLines.push(...uxb.slice(-80));
    }
    setLines(newLines);
  }, [ltiLog, debugVersion]);

  const text = ['BRIDGE DEBUG LOG:', ...lines].join('\n');

  if (!showBridgeLogUi) {
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
