/**
 * Canonical JSON helpers for WebM `PROMPT_DATA` mux (encode/decode) and codec verification tests.
 * The mux tag stores base64(JSON.stringify(payload)) so HTML and newlines in `promptSnapshotHtml`
 * do not break ffmpeg's single-line metadata values.
 */

export const FSASL_PROMPT_UPLOAD_KIND = 'fsasl_prompt_upload';

/** Subset of prompt-upload fields used for deterministic round-trip checks in tests. */
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

/** Deterministic JSON for codec tests (UTF-8, sorted keys at all object levels). */
export function stableStringifyForPromptMatch(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function parseJsonObject(
  raw: string,
  maxLen: number,
): { ok: true; obj: Record<string, unknown> } | { ok: false; error: string } {
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

/**
 * Compact JSON (no pretty-print) then base64 for ffmpeg `PROMPT_DATA=...` (single-line safe).
 */
export function encodePromptDataForFfmpegMetadataTag(payload: Record<string, unknown>): {
  tag: string;
  utf8ByteLength: number;
} {
  const json = JSON.stringify(payload);
  return {
    tag: Buffer.from(json, 'utf8').toString('base64'),
    utf8ByteLength: Buffer.byteLength(json, 'utf8'),
  };
}

export function decodePromptDataFromFfmpegMetadataTag(
  rawTag: string,
  maxDecodedUtf8Bytes: number,
): { ok: true; obj: Record<string, unknown>; utf8ByteLength: number } | { ok: false; error: string } {
  const s = (rawTag ?? '').trim();
  if (!s) return { ok: false, error: 'empty_tag' };

  /** Base64 payloads may be line-wrapped; strip whitespace before decode. */
  const compactB64 = s.replace(/\s+/g, '');
  let fromBase64: string | undefined;
  try {
    const decoded = Buffer.from(compactB64, 'base64').toString('utf8');
    if (decoded.length > 0) fromBase64 = decoded;
  } catch {
    /* treat as not base64 */
  }

  let jsonAfterBase64Error: string | undefined;
  if (fromBase64 != null) {
    const byteLen = Buffer.byteLength(fromBase64, 'utf8');
    if (byteLen > maxDecodedUtf8Bytes) return { ok: false, error: 'decoded_too_large' };
    const parsed = parseJsonObject(fromBase64, maxDecodedUtf8Bytes);
    if (parsed.ok) return { ok: true, obj: parsed.obj, utf8ByteLength: byteLen };
    jsonAfterBase64Error = parsed.error;
  }

  /** Tag may be raw JSON (not base64) depending on mux / tooling. */
  const directByteLen = Buffer.byteLength(s, 'utf8');
  if (directByteLen > maxDecodedUtf8Bytes) return { ok: false, error: 'tag_too_large' };
  const direct = parseJsonObject(s, maxDecodedUtf8Bytes);
  if (direct.ok) return { ok: true, obj: direct.obj, utf8ByteLength: directByteLen };

  return {
    ok: false,
    error: jsonAfterBase64Error ? `json_after_base64: ${jsonAfterBase64Error}` : direct.error,
  };
}
