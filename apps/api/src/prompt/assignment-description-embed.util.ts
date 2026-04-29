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

type EmbedBlock = {
  role: typeof ASL_EXPRESS_ROLE_CONFIG | typeof ASL_EXPRESS_ROLE_PROMPTS;
  start: number;
  end: number;
  /** Where inner text (JSON) ends — index of the matching `</` that closes the embed. */
  contentEnd: number;
};

const OPEN_TAG_PREFIX = '<div ';

/**
 * First `</div>` (case-insensitive, optional whitespace) at or after `from`, or null.
 */
function findNextCloseDivTag(html: string, from: number): { start: number; end: number } | null {
  const re = /<\/\s*div\s*>/i;
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

/**
 * Next raw `<div` open tag (not `</`…), for nested markup inside the embed. Entity-encoded
 * content (`&lt;div` …) is ignored: there is no literal `<`.
 */
function findNextOpenDivTag(html: string, from: number): { start: number; after: number } | null {
  const n = html.length;
  for (let i = from; i < n; i++) {
    if (html[i] !== '<') continue;
    if (i + 1 < n && html[i + 1] === '/') continue;
    if (!/^<\s*div\b/i.test(html.slice(i, i + 12))) continue;
    const gt = html.indexOf('>', i);
    if (gt === -1) return { start: i, after: n };
    return { start: i, after: gt + 1 };
  }
  return null;
}

/**
 * After the opening `>` of a `<div …>`, find where the inner *text* of that `div` ends
 * and where the `</div>` for that *same* tag ends. The naive first `</div>` after `>`
 * fails when the inner (e.g. prompts JSON) contains unescaped `</div>` in HTML strings.
 */
function findDivInnerAndBlockEnd(html: string, openTagEnd: number): { contentEnd: number; blockEnd: number } | null {
  const n = html.length;
  if (openTagEnd < 0 || openTagEnd >= n) return null;
  let i = openTagEnd + 1;
  let depth = 1;
  while (i < n) {
    const c = findNextCloseDivTag(html, i);
    if (!c) return null;
    const o = findNextOpenDivTag(html, i);
    if (!o) {
      depth -= 1;
      if (depth === 0) {
        return { contentEnd: c.start, blockEnd: c.end };
      }
      i = c.end;
      continue;
    }
    if (c.start < o.start) {
      depth -= 1;
      if (depth === 0) {
        return { contentEnd: c.start, blockEnd: c.end };
      }
      i = c.end;
    } else {
      depth += 1;
      i = o.after;
    }
  }
  return null;
}

/**
 * Find ASL Express embed `div` regions (v=1 + role). Does not require a fixed attribute order.
 * Closing tags are found by **depth** so a single embed’s inner `</div>` in prompt HTML
 * does not end the block early.
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
    const divStart = html.lastIndexOf(OPEN_TAG_PREFIX, vIdx);
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
    const be = findDivInnerAndBlockEnd(html, openTagEnd);
    if (!be) {
      from = vIdx + 1;
      continue;
    }
    const role = roleM[1] as typeof ASL_EXPRESS_ROLE_CONFIG | typeof ASL_EXPRESS_ROLE_PROMPTS;
    regions.push({ role, start: divStart, end: be.blockEnd, contentEnd: be.contentEnd });
    from = be.blockEnd;
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
    const inner = raw.slice(openTagEnd + 1, r.contentEnd);
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
