import { useState, useEffect, useRef } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { useAppMode } from '../contexts/AppModeContext';
import { useSearchParams } from 'react-router-dom';
import { ltiTokenHeaders } from '../api/lti-token';

interface BridgeLogProps {
  context: LtiContext | null;
  loading: boolean;
  error: string | null;
}

export function BridgeLog({ context, loading, error }: BridgeLogProps) {
  const { lastFunctionCalled, lastApiResult } = useDebug();
  const { isDeveloperMode } = useAppMode();
  const [searchParams] = useSearchParams();
  const isPrompterPath =
    window.location.pathname.includes('/prompter') ||
    window.location.pathname.includes('/config') ||
    window.location.pathname.includes('/viewer');
  /** Allow forcing Bridge Log with ?debug=1 (teachers only; students never see Bridge). */
  const debugParamEnabled = searchParams.get('debug') === '1';
  const isTeacherRole =
    /instructor|administrator|faculty|teacher|staff|contentdeveloper|teachingassistant|ta/i.test(
      context?.roles || '',
    );
  /** Students must not see Bridge; teachers see it on prompter routes or when dev / ?debug=1. */
  const developerUi =
    isTeacherRole && (isDeveloperMode || debugParamEnabled || isPrompterPath);
  const canClearLog = isDeveloperMode || debugParamEnabled;
  const [lastServerError, setLastServerError] = useState<{ endpoint: string; message: string } | null>(null);
  const [ltiLog, setLtiLog] = useState<string[]>([]);
  const [lines, setLines] = useState<string[]>(['Initializing...']);
  const containerRef = useRef<HTMLDivElement>(null);

  // When ?debug=1, force expanded and scroll into view (like my-canvas-app developer mode)
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
        const [errRes, ltiRes] = await Promise.all([
          fetch('/api/debug/last-error', { credentials: 'include', headers: ltiTokenHeaders() }),
          fetch('/api/debug/lti-log', { credentials: 'include', headers: ltiTokenHeaders() }),
        ]);
        if (cancelled) return;
        const errData = await errRes.json();
        const ltiData = await ltiRes.json();
        setLastServerError(errData ?? null);
        setLtiLog(Array.isArray(ltiData?.lines) ? ltiData.lines : []);
      } catch {
        if (!cancelled) setLastServerError(null);
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
    const lineLc = (line: string) => line.toLowerCase();
    const isSettingsBlobNoise = (line: string): boolean => {
      const lc = lineLc(line);
      return (
        lc.includes('settings blob') ||
        lc.includes('prompt manager settings assignment') ||
        lc.includes('ensurepromptmanagersettingsassignment') ||
        lc.includes('readpromptmanagersettingsblob')
      );
    };
    const isSyncTraceLine = (line: string): boolean => {
      const lc = lineLc(line);
      return (
        lc.includes('[placement]') ||
        lc.includes('sync-to-canvas: putconfig failed')
      ) && !isSettingsBlobNoise(line);
    };
    const isLaunchDiagnosticsLine = (line: string): boolean => {
      const lc = lineLc(line);
      return (
        lc.includes('[placement]') ||
        lc.includes('[launch-entry]') ||
        lc.includes('post /api/lti/launch received') ||
        lc.includes('post /api/lti/launch/prompter received') ||
        lc.includes('post /api/lti/launch/flashcards received')
      ) && !isSettingsBlobNoise(line);
    };
    const isDeckFlowLine = (line: string): boolean => {
      const lc = lineLc(line);
      return (
        lc.includes('[prompt-decks]') ||
        lc.includes('build-deck-prompts') ||
        lc.includes('deck flow') ||
        lc.includes('stored prompt banks') ||
        lc.includes('source selected') ||
        lc.includes('no prompts available')
      ) && !isSettingsBlobNoise(line);
    };

    // Assignment Group & Create Assignment section
    newLines.push('--- Assignment Group & Create Assignment ---');
    const agLines = ltiLog.filter(
      (line) =>
        (
          line.toLowerCase().includes('create-assignment failed') ||
          line.toLowerCase().includes('create-assignment success') ||
          line.toLowerCase().includes('create-assignment: completed successfully') ||
          line.toLowerCase().includes('delete-assignment')
        ) &&
        !isSettingsBlobNoise(line)
    );
    if (agLines.length > 0) {
      newLines.push(...agLines);
    } else {
      newLines.push('(No assignment group activity yet)');
    }

    // Save trace section (TeacherConfig save flow)
    newLines.push('');
    newLines.push('--- Save Trace ---');
    const syncLines = ltiLog.filter(isSyncTraceLine);
    if (syncLines.length > 0) {
      newLines.push(...syncLines);
    } else {
      newLines.push('(No sync trace lines yet)');
    }

    // Launch / module diagnostics (click path + stored Canvas state)
    newLines.push('');
    newLines.push('--- Module Launch Diagnostics ---');
    const launchDiagnosticsLines = ltiLog.filter(isLaunchDiagnosticsLine);
    if (launchDiagnosticsLines.length > 0) {
      newLines.push(...launchDiagnosticsLines);
    } else {
      newLines.push('(No launch diagnostics yet)');
    }

    // Deck prompt retrieval/build/fallback flow
    newLines.push('');
    newLines.push('--- Deck Prompt Flow (load/build/fallback) ---');
    const deckFlowLines = ltiLog.filter(isDeckFlowLine);
    if (deckFlowLines.length > 0) {
      newLines.push(...deckFlowLines);
    } else {
      newLines.push('(No deck prompt flow lines yet)');
    }

    // Video submission flow (Finish & Submit / timer expiry → Canvas)
    newLines.push('');
    newLines.push('--- Video Submission Flow (Finish & Submit → Canvas) ---');
    const submitLines = ltiLog.filter(
      (line) =>
        (
          line.includes('prompt-submit') ||
          line.includes('prompt-upload') ||
          line.includes('prompt-deeplink') ||
          line.includes('submit-deep-link') ||
          line.includes('upload-video') ||
          line.includes('writeSubmissionBody') ||
          line.includes('createSubmissionWithBody') ||
          line.includes('initiateUserFileUpload') ||
          line.includes('attachFileToSubmission') ||
          line.includes('uploadFileToCanvas') ||
          line.toLowerCase().includes('sproutvideo') ||
          line.includes('PromptFallbackStore') ||
          line.includes('fallback') ||
          (line.includes('prompt') && (line.includes('POST') || line.includes('submit') || line.includes('upload')))
        ) &&
        !isSettingsBlobNoise(line)
    );
    if (submitLines.length > 0) {
      newLines.push(...submitLines);
    } else {
      newLines.push('(No submission activity yet)');
    }

    // Duration pipeline (client probe → upload comment JSON → grader rows)
    newLines.push('');
    newLines.push('--- Duration pipeline ---');
    const durationLines = ltiLog.filter((line) => line.includes('] [duration] '));
    if (durationLines.length > 0) {
      newLines.push(...durationLines);
    } else {
      newLines.push('(No duration pipeline logs yet)');
    }

    // Resize diagnostics (temporary viewer panel drag telemetry)
    newLines.push('');
    newLines.push('--- Resize Diagnostics (panel drag telemetry) ---');
    const resizeLines = ltiLog.filter(
      (line) =>
        (line.includes('[resize]') ||
          line.toLowerCase().includes('resize-drag') ||
          line.toLowerCase().includes('leftstyleflex')) &&
        !isSettingsBlobNoise(line)
    );
    if (resizeLines.length > 0) {
      newLines.push(...resizeLines);
    } else {
      newLines.push('(No resize diagnostics yet)');
    }

    // Viewer / Grading flow (assignment select → getSubmissions → grade)
    newLines.push('');
    newLines.push('--- Viewer / Grading (select assignment → submissions) ---');
    const viewerLines = ltiLog.filter(
      (line) =>
        !line.includes('] [duration] ') &&
        !line.includes('listSubmissions') &&
        (line.includes('[viewer]') ||
          line.toLowerCase().includes('submissions') ||
          line.toLowerCase().includes('configured-assignments') ||
          line.includes('submissionHasFile') ||
          line.includes('getVideoUrlFromCanvasSubmission') ||
          line.includes('ENTRY:') ||
          line.includes('[debug]') ||
          line.includes('[resize]') ||
          line.toLowerCase().includes('resize-drag') ||
          line.includes('PING') ||
          line.includes('SproutVideo fallback') ||
          line.includes('fallback for user')) &&
        !isSettingsBlobNoise(line)
    );
    if (viewerLines.length > 0) {
      newLines.push(...viewerLines);
    } else {
      newLines.push('(No viewer/grading activity yet)');
    }

    if (lastFunctionCalled) {
      newLines.push('');
      newLines.push(`Last function: ${lastFunctionCalled}`);
    }
    if (lastApiResult) {
      newLines.push(`Last API: ${lastApiResult.endpoint} → ${lastApiResult.status} ${lastApiResult.ok ? 'OK' : 'FAILED'}`);
    }
    if (
      lastServerError &&
      (lastServerError.endpoint?.includes('config') ||
        lastServerError.endpoint?.includes('assignment-groups') ||
        lastServerError.endpoint?.includes('create-assignment') ||
        lastServerError.endpoint?.includes('submit') ||
        lastServerError.endpoint?.includes('upload-video') ||
        lastServerError.endpoint?.includes('submit-deep-link') ||
        lastServerError.endpoint?.includes('submissions') ||
        lastServerError.endpoint?.includes('configured-assignments'))
    ) {
      newLines.push('');
      newLines.push(`Error: ${lastServerError.endpoint}`);
      newLines.push(`  → ${lastServerError.message}`);
    }
    setLines(newLines);
  }, [lastFunctionCalled, lastApiResult, lastServerError, ltiLog]);

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
