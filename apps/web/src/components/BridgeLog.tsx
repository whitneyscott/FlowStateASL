import { useState, useEffect, useRef } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { useSearchParams } from 'react-router-dom';

interface BridgeLogProps {
  context: LtiContext | null;
  loading: boolean;
  error: string | null;
}

export function BridgeLog({ context, loading, error }: BridgeLogProps) {
  const { sproutVideoAccessed, sproutVideoPlaylistsRetrieved, lastFunctionCalled, lastApiResult, lastApiError, lastSubmissionDetails, lastCourseSettings } = useDebug();
  const [searchParams] = useSearchParams();
  const debugMode = searchParams.get('debug') === '1';
  const [lastServerError, setLastServerError] = useState<{ endpoint: string; message: string } | null>(null);
  const [ltiLog, setLtiLog] = useState<string[]>([]);
  const [lines, setLines] = useState<string[]>(['Initializing...']);
  const containerRef = useRef<HTMLDivElement>(null);

  // When ?debug=1, force expanded and scroll into view (like my-canvas-app developer mode)
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (debugMode) {
      setExpanded(true);
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [debugMode]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const [errRes, ltiRes] = await Promise.all([
          fetch('/api/debug/last-error', { credentials: 'include' }),
          fetch('/api/debug/lti-log', { credentials: 'include' }),
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
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  const [copied, setCopied] = useState(false);

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
    if (loading) {
      newLines.push('Fetching LTI context...');
    } else if (error) {
      newLines.push(`Error: ${error}`);
    } else if (context) {
      const isStandalone =
        context.userId === 'standalone' || !context.courseId;
      if (isStandalone) {
        newLines.push('No LTI launch detected. Standalone mode.');
        newLines.push('Loading full menu.');
      } else {
        newLines.push('LTI Launch Detected');
        newLines.push(`Course ID: ${context.courseId}`);
        if (context.moduleId) newLines.push(`Module ID: ${context.moduleId}`);
        if (context.assignmentId)
          newLines.push(`Assignment ID: ${context.assignmentId}`);
        newLines.push(`Roles: ${context.roles || '(none)'}`);
        const teacherPatterns = ['instructor','administrator','teacher','ta','staff'];
        const isTeacher = context.roles && teacherPatterns.some((p) =>
          context.roles!.toLowerCase().includes(p)
        );
        newLines.push(`Teacher mode: ${isTeacher ? 'ON' : 'OFF'}`);
        newLines.push(`Tool: ${context.toolType}`);
        if (context.customToolTypeFromJwt) {
          newLines.push(`Tool type (Step 4): custom.tool_type="${context.customToolTypeFromJwt}" → ${context.toolType}`);
        }
        if (context.redirectPath) {
          newLines.push(`Redirect path (Step 2): ${context.redirectPath}`);
        }
        if (context.agsLineitemsUrl || context.agsLineitemUrl) {
          if (context.agsLineitemUrl) newLines.push(`AGS (Step 6): lineitem=${context.agsLineitemUrl}`);
          if (context.agsLineitemsUrl) newLines.push(`AGS (Step 6): lineitems=${context.agsLineitemsUrl}`);
        } else {
          newLines.push(`AGS (Step 6): (absent — enable AGS on Developer Key for grade passback)`);
        }
      }
    } else {
      newLines.push('No context available.');
    }
    if (sproutVideoAccessed) {
      newLines.push(`SproutVideo API: accessed, ${sproutVideoPlaylistsRetrieved ?? '?'} playlists`);
    } else if (context?.toolType === 'flashcards') {
      newLines.push('SproutVideo API: not yet accessed');
    }
    if (lastFunctionCalled) {
      newLines.push(`Last function: ${lastFunctionCalled}`);
    }
    if (lastApiResult) {
      newLines.push(`Last API: ${lastApiResult.endpoint} → ${lastApiResult.status} ${lastApiResult.ok ? 'OK' : 'FAILED'}`);
    }
    if (lastApiError) {
      newLines.push(`API Error: ${lastApiError.endpoint} ${lastApiError.status} - ${lastApiError.message}`);
    }
    if (lastServerError) {
      newLines.push(`Last error (500): ${lastServerError.endpoint}`);
      newLines.push(`  → ${lastServerError.message}`);
    }
    if (lastSubmissionDetails) {
      newLines.push('Submission details:', lastSubmissionDetails);
    }
    if (lastCourseSettings) {
      newLines.push('Course settings (from Flashcard Settings assignment):');
      newLines.push(`  selectedCurriculums: ${JSON.stringify(lastCourseSettings.selectedCurriculums)}`);
      newLines.push(`  selectedUnits: ${JSON.stringify(lastCourseSettings.selectedUnits)}`);
      const d = lastCourseSettings._debug;
      if (d) {
        newLines.push(`  [debug] Assignment: "${d.assignmentTitle}" (id: ${d.flashcardSettingsAssignmentId ?? 'none'})`);
        newLines.push(`  [debug] courseIdUsed: ${d.courseIdUsed} | canvasDomainUsed: ${d.canvasDomainUsed || '(env)'} | findResult: ${d.findResult}`);
        newLines.push(`  [debug] tokenStatus: ${d.tokenStatus ?? '(not set)'}`);
        if (d.canvasApiResponse) {
          newLines.push(`  [debug] Canvas API response: ${d.canvasApiResponse}`);
        }
        newLines.push(`  [debug] requestFindByTitle: ${d.requestFindByTitle}`);
        if (d.requestGetAssignment) {
          newLines.push(`  [debug] requestGetAssignment: ${d.requestGetAssignment}`);
        }
      }
    }
    // LTI launch log from backend (OIDC, launch steps, errors)
    if (ltiLog.length > 0) {
      newLines.push('--- LTI Launch Log ---');
      newLines.push(...ltiLog);
    }
    setLines(newLines);
  }, [context, loading, error, sproutVideoAccessed, sproutVideoPlaylistsRetrieved, lastFunctionCalled, lastApiResult, lastApiError, lastSubmissionDetails, lastCourseSettings, lastServerError, ltiLog]);

  const text = ['BRIDGE DEBUG LOG:', ...lines].join('\n');

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
          onClick={async () => {
            await fetch('/api/debug/lti-log?clear=1', { credentials: 'include' });
            setLtiLog([]);
          }}
          title="Clear LTI log"
          style={{
            background: 'none',
            border: '1px solid #00ff88',
            color: '#00ff88',
            padding: '4px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 11,
            marginRight: 8,
          }}
        >
          Clear LTI log
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
