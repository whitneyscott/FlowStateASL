/** Strip common XSS vectors from teacher-authored feedback HTML before DOM insertion or Canvas POST. */
export function sanitizeTeacherFeedbackHtml(html: string): string {
  let s = (html ?? '').trim();
  if (!s) return '';
  s = s.replace(/<\/(?:script|style|iframe|object|embed)\b[^>]*>/gi, '');
  s = s.replace(/<(?:script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed)>/gi, '');
  s = s.replace(/\son\w+\s*=\s*(["'])[\s\S]*?\1/gi, '');
  s = s.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  s = s.replace(/javascript:/gi, '');
  return s;
}

export function feedbackEditorIsEmpty(html: string): boolean {
  if (!(html ?? '').trim()) return true;
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').trim().length === 0;
}
