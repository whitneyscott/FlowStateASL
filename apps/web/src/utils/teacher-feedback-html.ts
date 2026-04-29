/** `<img src>` allowed in prompts: same-origin proxy to Canvas course files only (no arbitrary URLs). */
export function isAllowedPromptImageSrc(src: string): boolean {
  const u = (src ?? '').trim();
  if (!u) return false;
  if (/^\/api\/prompt\/course-files\/\d+\/view(?:[?#][^\s]*)?$/i.test(u)) return true;
  try {
    const parsed = new URL(u, typeof window !== 'undefined' ? window.location.origin : 'https://placeholder.local');
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (/^\/api\/prompt\/course-files\/\d+\/view(?:[?#].*)?$/i.test(path)) return true;
  } catch {
    return false;
  }
  return false;
}

/** Strip common XSS vectors from teacher-authored feedback HTML before DOM insertion or Canvas POST. */
export function sanitizeTeacherFeedbackHtml(html: string): string {
  let s = (html ?? '').trim();
  if (!s) return '';
  s = s.replace(/<\/(?:script|style|iframe|object|embed)\b[^>]*>/gi, '');
  s = s.replace(/<(?:script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed)>/gi, '');
  s = s.replace(/\son\w+\s*=\s*(["'])[\s\S]*?\1/gi, '');
  s = s.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  s = s.replace(/javascript:/gi, '');
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawSrc = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim();
    if (isAllowedPromptImageSrc(rawSrc)) return tag;
    return '';
  });
  return s;
}

export function feedbackEditorIsEmpty(html: string): boolean {
  if (!(html ?? '').trim()) return true;
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').trim().length === 0;
}
