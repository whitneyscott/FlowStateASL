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
  const { lastFunctionCalled, lastApiResult } = useDebug();
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

    // Assignment Group & Create Assignment section
    newLines.push('--- Assignment Group & Create Assignment ---');
    const agLines = ltiLog.filter(
      (line) =>
        line.toLowerCase().includes('assignment group') ||
        line.toLowerCase().includes('create-assignment') ||
        line.toLowerCase().includes('createassignment') ||
        line.toLowerCase().includes('create-group') ||
        line.toLowerCase().includes('update-due-at')
    );
    if (agLines.length > 0) {
      newLines.push(...agLines);
    } else {
      newLines.push('(No assignment group activity yet)');
    }

    // Video submission flow (Finish & Submit / timer expiry → Canvas)
    newLines.push('');
    newLines.push('--- Video Submission Flow (Finish & Submit → Canvas) ---');
    const submitLines = ltiLog.filter(
      (line) =>
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
        (line.includes('prompt') && (line.includes('POST') || line.includes('submit') || line.includes('upload')))
    );
    if (submitLines.length > 0) {
      newLines.push(...submitLines);
    } else {
      newLines.push('(No submission activity yet)');
    }

    // Viewer / Grading flow (assignment select → getSubmissions → grade)
    newLines.push('');
    newLines.push('--- Viewer / Grading (select assignment → submissions) ---');
    const viewerLines = ltiLog.filter(
      (line) =>
        line.includes('[viewer]') ||
        line.toLowerCase().includes('submissions') ||
        line.toLowerCase().includes('configured-assignments')
    );
    if (viewerLines.length > 0) {
      newLines.push(...viewerLines);
    } else {
      newLines.push('(No viewer/grading activity yet)');
    }

    const agOrSubmitRelated =
      lastFunctionCalled?.includes('assignment-groups') ||
      lastFunctionCalled?.includes('create-assignment') ||
      lastFunctionCalled?.includes('submit') ||
      lastFunctionCalled?.includes('upload-video') ||
      lastFunctionCalled?.includes('submit-deep-link') ||
      lastFunctionCalled?.includes('submissions') ||
      lastFunctionCalled?.includes('configured-assignments') ||
      (lastFunctionCalled?.includes('config') && lastApiResult?.endpoint?.includes('config'));
    if (agOrSubmitRelated && lastFunctionCalled) {
      newLines.push('');
      newLines.push(`Last function: ${lastFunctionCalled}`);
    }
    if (agOrSubmitRelated && lastApiResult) {
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
