import { useState, useEffect } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';

interface BridgeLogProps {
  context: LtiContext | null;
  loading: boolean;
  error: string | null;
}

export function BridgeLog({ context, loading, error }: BridgeLogProps) {
  const { sproutVideoAccessed, sproutVideoPlaylistsRetrieved, lastFunctionCalled, lastApiResult } = useDebug();
  const [lastServerError, setLastServerError] = useState<{ endpoint: string; message: string } | null>(null);
  const [lines, setLines] = useState<string[]>(['Initializing...']);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/debug/last-error', { credentials: 'include' });
        if (cancelled) return;
        const data = await res.json();
        setLastServerError(data ?? null);
      } catch {
        if (!cancelled) setLastServerError(null);
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  const [expanded, setExpanded] = useState(true);
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
    if (lastServerError) {
      newLines.push(`Last error (500): ${lastServerError.endpoint}`);
      newLines.push(`  → ${lastServerError.message}`);
    }
    setLines(newLines);
  }, [context, loading, error, sproutVideoAccessed, sproutVideoPlaylistsRetrieved, lastFunctionCalled, lastApiResult, lastServerError]);

  const text = ['BRIDGE DEBUG LOG:', ...lines].join('\n');

  return (
    <div
      style={{
        background: '#000',
        color: '#00ff88',
        fontFamily: 'monospace',
        padding: 12,
        border: '2px solid #00ff88',
        margin: '10px auto 20px auto',
        textAlign: 'left',
        whiteSpace: 'pre-wrap',
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
