import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { PromptConfigJson } from '../../prompt/dto/prompt-config.dto';
import { normalizeToCanvasRestBase } from './canvas-base-url.util';

/** Match view URL with optional existing `?…` so re-signing GET /config does not leave duplicate query junk. */
const VIEW_PATH_RE = /\/api\/prompt\/course-files\/(\d+)\/view(?:\?[^"'>\s]*)?/gi;

/** Signed GET params so `<img src>` can load without Authorization (browser never sends Bearer). */
export function coursePromptImageViewSecret(config: ConfigService): string {
  const explicit = config.get<string>('COURSE_PROMPT_IMAGE_VIEW_SECRET')?.trim();
  if (explicit) return explicit;
  const session = config.get<string>('SESSION_SECRET')?.trim();
  if (session) return session;
  if (config.get<string>('NODE_ENV') !== 'production') {
    return 'flowstate-dev-course-prompt-image-view-secret';
  }
  throw new Error('Set COURSE_PROMPT_IMAGE_VIEW_SECRET or SESSION_SECRET for signed course image URLs');
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function parseExp(eRaw: string): number | null {
  const n = Number.parseInt(eRaw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Remove `?…` from proxied course file view URLs so persisted HTML stays canonical.
 */
export function stripCourseImageViewSignedQueryFromHtml(html: string): string {
  const s = html ?? '';
  return s.replace(/(\/api\/prompt\/course-files\/\d+\/view)\?[^"'>\s]*/gi, '$1');
}

export function appendSignedQueryToCourseImageViewPath(
  viewPathNoQuery: string,
  fileId: string,
  courseId: string,
  canvasBaseUrl: string | null | undefined,
  config: ConfigService,
): string {
  const path = (viewPathNoQuery ?? '').trim().split('?')[0];
  const fid = (fileId ?? '').trim();
  const cid = (courseId ?? '').trim();
  if (!path || !/^\d+$/.test(fid) || !cid) return path;
  const canvasBase = normalizeToCanvasRestBase(canvasBaseUrl ?? undefined) ?? '';
  const secret = coursePromptImageViewSecret(config);
  const expSec = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const payload = `v1|${fid}|${cid}|${canvasBase}|${expSec}`;
  const sig = hmacHex(secret, payload);
  const q = new URLSearchParams({ c: cid, e: String(expSec), sig, ...(canvasBase ? { b: canvasBase } : {}) });
  return `${path}?${q.toString()}`;
}

export function verifySignedCourseImageViewRequest(req: Request, pathFileId: string, config: ConfigService): boolean {
  const fid = (pathFileId ?? '').trim();
  if (!/^\d+$/.test(fid)) return false;
  const c = firstQuery(req.query.c);
  const b = normalizeToCanvasRestBase(firstQuery(req.query.b)) ?? '';
  const e = firstQuery(req.query.e);
  const sig = firstQuery(req.query.sig);
  if (!c || !e || !sig) return false;
  const expSec = parseExp(e);
  if (expSec == null) return false;
  if (expSec < Math.floor(Date.now() / 1000)) return false;
  const secret = coursePromptImageViewSecret(config);
  const payload = `v1|${fid}|${c}|${b}|${expSec}`;
  const expectedHex = hmacHex(secret, payload);
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function firstQuery(v: unknown): string {
  if (Array.isArray(v)) return String(v[0] ?? '').trim();
  if (v == null) return '';
  return String(v).trim();
}

export function rewriteHtmlWithSignedCourseImageViews(
  html: string | undefined,
  courseId: string,
  canvasBaseUrl: string | null | undefined,
  config: ConfigService,
): string | undefined {
  if (typeof html !== 'string' || !html.trim()) return html;
  const cid = (courseId ?? '').trim();
  if (!cid) return html;
  const canvasBase = normalizeToCanvasRestBase(canvasBaseUrl ?? undefined) ?? '';
  const secret = coursePromptImageViewSecret(config);
  return html.replace(VIEW_PATH_RE, (full, fid) => {
    const viewBase = `/api/prompt/course-files/${fid}/view`;
    const expSec = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    const payload = `v1|${fid}|${cid}|${canvasBase}|${expSec}`;
    const sig = hmacHex(secret, payload);
    const q = new URLSearchParams({ c: cid, e: String(expSec), sig, ...(canvasBase ? { b: canvasBase } : {}) });
    return `${viewBase}?${q.toString()}`;
  });
}

export function applySignedCourseImageViewsToConfig(
  cfg: PromptConfigJson,
  courseId: string,
  canvasBaseUrl: string | null | undefined,
  config: ConfigService,
): PromptConfigJson {
  const cid = (courseId ?? '').trim();
  if (!cid) return cfg;
  const next: PromptConfigJson = { ...cfg };
  if (Array.isArray(next.prompts) && next.prompts.length > 0) {
    next.prompts = next.prompts.map(
      (p) => rewriteHtmlWithSignedCourseImageViews(String(p ?? ''), cid, canvasBaseUrl, config) ?? '',
    );
  }
  if (typeof next.instructions === 'string' && next.instructions.trim()) {
    next.instructions =
      rewriteHtmlWithSignedCourseImageViews(next.instructions, cid, canvasBaseUrl, config) ?? next.instructions;
  }
  return next;
}
