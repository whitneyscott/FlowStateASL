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

/** Strip host from saved absolute proxy URLs so embeds stay portable. */
export function normalizePromptImageSrcForStorage(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) {
    try {
      const parsed = new URL(t);
      let path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      path = path.replace(/^(\/api\/prompt\/course-files\/\d+\/view)\?[^#]*/i, '$1');
      return path;
    } catch {
      return t.startsWith('/') ? t : `/${t}`;
    }
  }
  const root = t.startsWith('/') ? t : `/${t}`;
  return root.replace(/^(\/api\/prompt\/course-files\/\d+\/view)\?[^#]*/i, '$1');
}

/**
 * Browser `<img>` requests omit Authorization; course file views need a signed `?sig=` query.
 * Keep that query for DOM display; storage/API paths strip it server- and client-side when saving.
 */
function coursePromptImageSrcForDisplay(rawSrc: string, canonicalNoQuery: string): string {
  const r = (rawSrc ?? '').trim();
  if (!r) return canonicalNoQuery;
  let pathWithSearch = '';
  if (/^https?:\/\//i.test(r)) {
    try {
      const u = new URL(r);
      pathWithSearch = `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return canonicalNoQuery;
    }
  } else {
    pathWithSearch = r.startsWith('/') ? r : `/${r}`;
  }
  const qIdx = pathWithSearch.indexOf('?');
  const basePath = (qIdx >= 0 ? pathWithSearch.slice(0, qIdx) : pathWithSearch).split('#')[0];
  if (normalizePromptImageSrcForStorage(basePath) !== canonicalNoQuery) return canonicalNoQuery;
  if (qIdx >= 0 && /(?:[?&])sig=/i.test(pathWithSearch)) {
    return pathWithSearch.split('#')[0];
  }
  return canonicalNoQuery;
}

function sanitizeTeacherFeedbackHtmlWithImageMode(html: string, imageMode: 'storage' | 'display'): string {
  let s = (html ?? '').trim();
  if (!s) return '';
  s = s.replace(/<\/(?:script|style|iframe|object|embed)\b[^>]*>/gi, '');
  s = s.replace(/<(?:script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed)>/gi, '');
  s = s.replace(/\son\w+\s*=\s*(["'])[\s\S]*?\1/gi, '');
  s = s.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  s = s.replace(/javascript:/gi, '');
  s = s.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    const m = attrs.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawSrc = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim();
    const canonical = normalizePromptImageSrcForStorage(rawSrc);
    if (!isAllowedPromptImageSrc(canonical)) return '';
    const outSrc = imageMode === 'display' ? coursePromptImageSrcForDisplay(rawSrc, canonical) : canonical;
    const esc = outSrc.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const newAttrs = attrs.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="${esc}"`);
    return `<img${newAttrs}>`;
  });
  return s;
}

/** Strip common XSS vectors; normalize course images to unsigned paths for PUT / storage. */
export function sanitizeTeacherFeedbackHtml(html: string): string {
  return sanitizeTeacherFeedbackHtmlWithImageMode(html, 'storage');
}

/** Same XSS rules as storage, but keep signed `?sig=` on course file images so `<img src>` loads in the browser. */
export function sanitizeTeacherFeedbackHtmlForDisplay(html: string): string {
  return sanitizeTeacherFeedbackHtmlWithImageMode(html, 'display');
}

export function feedbackEditorIsEmpty(html: string): boolean {
  if (!(html ?? '').trim()) return true;
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').trim().length === 0;
}
