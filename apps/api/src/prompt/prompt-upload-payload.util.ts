/**
 * Canonical JSON helpers for WebM `PROMPT_DATA` mux and PROMPT_MATCH comparisons.
 * Stored mux value should match the submission comment JSON string (same keys/values as sent to Canvas).
 * Comparisons use stable key ordering so key order drift does not false-negative.
 */

export const FSASL_PROMPT_UPLOAD_KIND = 'fsasl_prompt_upload';

/** Fields mirrored from the post-upload submission comment (excluding envelope-only keys for match). */
export type ComparablePromptUploadFields = {
  deckTimeline?: unknown;
  durationSeconds?: unknown;
  mediaStimulus?: unknown;
  promptSnapshotHtml?: unknown;
};

export function extractComparablePromptUploadFields(raw: Record<string, unknown>): ComparablePromptUploadFields {
  const out: ComparablePromptUploadFields = {};
  if ('deckTimeline' in raw) out.deckTimeline = raw.deckTimeline;
  if ('durationSeconds' in raw) out.durationSeconds = raw.durationSeconds;
  if ('mediaStimulus' in raw) out.mediaStimulus = raw.mediaStimulus;
  if ('promptSnapshotHtml' in raw) out.promptSnapshotHtml = raw.promptSnapshotHtml;
  return out;
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const next: Record<string, unknown> = {};
  for (const k of keys) {
    next[k] = sortKeysDeep(o[k]);
  }
  return next;
}

/** Deterministic JSON for PROMPT_MATCH (UTF-8, sorted keys at all object levels). */
export function stableStringifyForPromptMatch(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function parseJsonObject(raw: string, maxLen: number): { ok: true; obj: Record<string, unknown> } | { ok: false; error: string } {
  const s = (raw ?? '').trim();
  if (!s) return { ok: false, error: 'empty' };
  if (s.length > maxLen) return { ok: false, error: 'too_long' };
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'not_object' };
    }
    return { ok: true, obj: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: `json_parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}
