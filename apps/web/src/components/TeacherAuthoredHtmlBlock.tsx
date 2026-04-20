import { useMemo } from 'react';
import { sanitizeTeacherFeedbackHtml } from '../utils/teacher-feedback-html';

/** Renders teacher-authored HTML (prompts, instructions) with the same XSS guard as feedback. */
export function TeacherAuthoredHtmlBlock({ html, className }: { html: string; className?: string }) {
  const safe = useMemo(() => sanitizeTeacherFeedbackHtml(html ?? ''), [html]);
  if (!safe) return null;
  return <div className={className} dangerouslySetInnerHTML={{ __html: safe }} />;
}
