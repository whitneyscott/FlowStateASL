import { useState, useEffect } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';

interface BridgeLogProps {
  context: LtiContext | null;
  loading: boolean;
  error: string | null;
}

export function BridgeLog({ context, loading, error }: BridgeLogProps) {
  const [lines, setLines] = useState<string[]>(['Initializing...']);
  const [expanded, setExpanded] = useState(true);

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
        newLines.push(`Tool: ${context.toolType}`);
      }
    } else {
      newLines.push('No context available.');
    }
    setLines(newLines);
  }, [context, loading, error]);

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
          marginBottom: expanded ? 4 : 0,
        }}
      >
        {expanded ? '▼' : '▶'} BRIDGE DEBUG LOG
      </button>
      {expanded && <div>{text.split('\n').slice(1).join('\n')}</div>}
    </div>
  );
}
