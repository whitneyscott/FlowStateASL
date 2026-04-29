import { appendLtiLog } from '../common/last-error.store';
import type { PromptConfigJson } from './dto/prompt-config.dto';
import { sanitizePromptConfigJson } from './prompt-settings-blob-repair.util';

export const ASL_EXPRESS_EMBED_V = '1' as const;
export const ASL_EXPRESS_ROLE_CONFIG = 'config' as const;
export const ASL_EXPRESS_ROLE_PROMPTS = 'prompts' as const;

/** HTML-entity encode JSON text placed inside a div (Canvas/RCE safe). */
export function escapeJsonForHtmlTextNode(json: string): string {
  return json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

type EmbedBlock = { role: typeof ASL_EXPRESS_ROLE_CONFIG | typeof ASL_EXPRESS_ROLE_PROMPTS; start: number; end: number };

const OPEN_TAG_PREFIX = '<div ';

/**
 * Locate the opening `<div ...>` for an ASL embed that owns `data-asl-express-v` near `vIdx`.
 * Canvas may normalize casing and spacing; do not rely on `lastIndexOf('<div ', vIdx)` alone.
 */
function findAslEmbedOpenDivStart(html: string, vIdx: number): number {
  const lower = html.toLowerCase();
  let pos = vIdx;
  for (;;) {
    const i = lower.lastIndexOf('<div', pos);
    if (i === -1) return -1;
    const tagEnd = html.indexOf('>', i);
    if (tagEnd === -1) return -1;
    if (tagEnd > vIdx) {
      pos = i - 1;
      continue;
    }
    const afterDiv = html.slice(i + 4, i + 5);
    if (afterDiv && !/[\s/>]/u.test(afterDiv)) {
      pos = i - 1;
      continue;
    }
    const slice = html.slice(i, tagEnd + 1);
    if (!/data-asl-express-v=["']1["']/i.test(slice) || !/data-asl-express-role=["'](config|prompts)["']/i.test(slice)) {
      pos = i - 1;
      continue;
    }
    return i;
  }
}

/**
 * Matching close `</div>` for an embed, counting nested divs. Required when Canvas (or entity decode)
 * leaves literal `</div>` sequences inside the JSON text node — `indexOf('</div>')` would truncate early.
 */
function findMatchingEmbedCloseDiv(html: string, openTagEnd: number): number {
  let depth = 1;
  let pos = openTagEnd + 1;
  const lower = html.toLowerCase();
  while (pos < html.length && depth > 0) {
    const nextOpen = lower.indexOf('<div', pos);
    const nextClose = lower.indexOf('</div>', pos);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      pos = nextOpen + 4;
    } else {
      depth -= 1;
      if (depth === 0) return nextClose;
      pos = nextClose + 6;
    }
  }
  return -1;
}

/**
 * Find ASL Express embed `div` regions (v=1 + role). Does not require a fixed attribute order.
 */
function findAllEmbedBlockRegions(html: string): EmbedBlock[] {
  const regions: EmbedBlock[] = [];
  let from = 0;
  for (;;) {
    const vIdx = html.indexOf('data-asl-express-v=', from);
    if (vIdx === -1) break;
    const m = /data-asl-express-v=["']1["']/.exec(html.slice(vIdx, vIdx + 40));
    if (!m) {
      from = vIdx + 1;
      continue;
    }
    const divStart = findAslEmbedOpenDivStart(html, vIdx);
    if (divStart === -1) {
      from = vIdx + 1;
      continue;
    }
    const openTagEnd = html.indexOf('>', divStart);
    if (openTagEnd === -1) break;
    const openSlice = html.slice(divStart, openTagEnd);
    if (!/data-asl-express-v=["']1["']/.test(openSlice) || !/data-asl-express-role=["'](config|prompts)["']/.test(openSlice)) {
      from = vIdx + 1;
      continue;
    }
    const roleM = /data-asl-express-role=["'](config|prompts)["']/.exec(openSlice);
    if (!roleM) {
      from = vIdx + 1;
      continue;
    }
    const close = findMatchingEmbedCloseDiv(html, openTagEnd);
    if (close === -1) break;
    const role = roleM[1] as typeof ASL_EXPRESS_ROLE_CONFIG | typeof ASL_EXPRESS_ROLE_PROMPTS;
    regions.push({ role, start: divStart, end: close + '</div>'.length });
    from = close + 6;
  }
  return regions;
}

/**
 * Returns HTML with all ASL Express embed `div` regions removed, preserving order of other content.
 */
export function stripAslExpressEmbeds(html: string): { visibleHtml: string; removedBlockCount: number } {
  if (!html) return { visibleHtml: '', removedBlockCount: 0 };
  const regions = findAllEmbedBlockRegions(html);
  if (regions.length === 0) return { visibleHtml: html, removedBlockCount: 0 };
  let out = html;
  for (let i = regions.length - 1; i >= 0; i--) {
    const { start, end } = regions[i]!;
    out = out.slice(0, start) + out.slice(end);
  }
  return { visibleHtml: out, removedBlockCount: regions.length };
}

export interface ParseAssignmentDescriptionResult {
  visibleHtml: string;
  config: PromptConfigJson | null;
  prompts: string[];
  repairNotes: string[];
}

/**
 * Last matching node per role wins; records duplicate and invalid JSON in `repairNotes`.
 */
export function parseAssignmentDescriptionForPromptManager(html: string | undefined | null): ParseAssignmentDescriptionResult {
  const raw = (html ?? '').trim();
  const repairNotes: string[] = [];
  if (!raw) {
    return { visibleHtml: '', config: null, prompts: [], repairNotes };
  }
  const regions = findAllEmbedBlockRegions(raw);
  const { visibleHtml } = stripAslExpressEmbeds(raw);
  if (regions.length === 0) {
    return { visibleHtml, config: null, prompts: [], repairNotes };
  }
  const byRole: Record<string, { inner: string; count: number }> = {
    [ASL_EXPRESS_ROLE_CONFIG]: { inner: '', count: 0 },
    [ASL_EXPRESS_ROLE_PROMPTS]: { inner: '', count: 0 },
  };
  for (const r of regions) {
    const openTagEnd = raw.indexOf('>', r.start);
    if (openTagEnd === -1 || r.end < openTagEnd) {
      repairNotes.push('embed_malformed_skipped');
      continue;
    }
    const inner = raw.slice(openTagEnd + 1, r.end - '</div>'.length);
    const b = (byRole[r.role] = byRole[r.role] ?? { inner: '', count: 0 });
    b.count += 1;
    b.inner = inner;
  }
  for (const r of [ASL_EXPRESS_ROLE_CONFIG, ASL_EXPRESS_ROLE_PROMPTS] as const) {
    if ((byRole[r]?.count ?? 0) > 1) {
      repairNotes.push(`asl_express_embed_duplicate_role_${r}`);
      appendLtiLog('prompt-embed', 'parseAssignmentDescription: duplicate embed blocks (last wins)', {
        role: r,
        count: byRole[r]!.count,
      });
    }
  }
  let config: PromptConfigJson | null = null;
  const cfgText = (byRole[ASL_EXPRESS_ROLE_CONFIG]?.inner ?? '').trim();
  if (cfgText) {
    try {
      const decoded = decodeBasicHtmlEntities(cfgText);
      const obj = JSON.parse(decoded) as unknown;
      config = sanitizePromptConfigJson(obj);
    } catch (e) {
      repairNotes.push('config_json_parse_failed');
      appendLtiLog('prompt-embed', 'parseAssignmentDescription: config JSON failed', { error: String(e) });
    }
  }
  const prompts: string[] = [];
  const prText = (byRole[ASL_EXPRESS_ROLE_PROMPTS]?.inner ?? '').trim();
  if (prText) {
    try {
      const decoded = decodeBasicHtmlEntities(prText);
      const arr = JSON.parse(decoded) as unknown;
      if (Array.isArray(arr)) {
        for (const p of arr) {
          const t = String(p ?? '').trim();
          if (t) prompts.push(t);
        }
      } else {
        repairNotes.push('prompts_not_array');
      }
    } catch (e) {
      repairNotes.push('prompts_json_parse_failed');
      appendLtiLog('prompt-embed', 'parseAssignmentDescription: prompts JSON failed', { error: String(e) });
    }
  }
  if (config) {
    config = { ...config, ...((prompts.length > 0 ? { prompts } : {}) as { prompts: string[] }) };
  } else if (prompts.length) {
    config = { minutes: 5, prompts, accessCode: '' };
  }
  if (config && 'instructions' in (config as Record<string, unknown>)) {
    const c = { ...(config as PromptConfigJson) };
    delete (c as { instructions?: string }).instructions;
    config = c;
  }
  // Never treat moduleId from legacy embeds as authoritative — Prompt Manager resolves it from Canvas.
  if (config) {
    const c = { ...(config as PromptConfigJson) };
    delete (c as { moduleId?: string }).moduleId;
    config = c;
  }
  return { visibleHtml, config, prompts, repairNotes };
}

export function toPromptConfigForEmbed(c: PromptConfigJson): Record<string, unknown> {
  const o = { ...(c as Record<string, unknown>) };
  delete o.prompts;
  delete o.instructions;
  delete o.resolvedAssignmentId;
  /** Module placement is derived from Canvas module items on read, not duplicated in the embed. */
  delete o.moduleId;
  return o;
}

/**
 * Append two terminal hidden embed divs. Strips any existing ASL embeds from `visible` first.
 */
export function mergeAssignmentDescriptionWithEmbeds(visible: string, config: PromptConfigJson, prompts: string[] | undefined): string {
  const { visibleHtml: base } = stripAslExpressEmbeds(visible);
  const cfg = toPromptConfigForEmbed(config);
  const promptList = Array.isArray(prompts) ? prompts : [];
  const configJson = JSON.stringify(cfg);
  const promptsJson = JSON.stringify(promptList);
  const a = escapeJsonForHtmlTextNode(configJson);
  const b = escapeJsonForHtmlTextNode(promptsJson);
  const suffix =
    `${OPEN_TAG_PREFIX}data-asl-express-v="${ASL_EXPRESS_EMBED_V}" data-asl-express-role="${ASL_EXPRESS_ROLE_CONFIG}" style="display:none" aria-hidden="true">` +
    a +
    `</div>` +
    `${OPEN_TAG_PREFIX}data-asl-express-v="${ASL_EXPRESS_EMBED_V}" data-asl-express-role="${ASL_EXPRESS_ROLE_PROMPTS}" style="display:none" aria-hidden="true">` +
    b +
    `</div>`;
  const t = base.trimEnd();
  if (!t) return suffix.trim();
  return `${t}\n${suffix}`;
}
