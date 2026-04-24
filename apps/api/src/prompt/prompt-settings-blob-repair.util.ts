import type { PromptConfigJson } from './dto/prompt-config.dto';
import type { PromptManagerSettingsBlob } from './prompt-manager-settings-blob.storage';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Keep only JSON-serializable fields we recognize on persisted prompt configs. */
export function sanitizePromptConfigJson(input: unknown): PromptConfigJson {
  if (!isPlainObject(input)) return {};
  const rec = input;
  const out: PromptConfigJson = {};
  const str = (k: keyof PromptConfigJson) => {
    const v = rec[k as string];
    if (typeof v === 'string' && v.trim()) (out as Record<string, unknown>)[k as string] = v.trim();
  };
  str('assignmentName');
  str('assignmentGroupId');
  str('moduleId');
  if (rec.rubricId != null) {
    if (typeof rec.rubricId === 'string' && rec.rubricId.trim()) {
      (out as { rubricId?: string }).rubricId = rec.rubricId.trim();
    } else {
      const n = Number(rec.rubricId);
      if (Number.isFinite(n) && n > 0) (out as { rubricId?: string }).rubricId = String(Math.floor(n));
    }
  }
  str('instructions');
  str('dueAt');
  str('unlockAt');
  str('lockAt');
  str('version');
  str('accessCode');
  const minutes = Number(rec.minutes);
  if (Number.isFinite(minutes) && minutes >= 0) out.minutes = minutes;
  const pp = Number(rec.pointsPossible);
  if (Number.isFinite(pp) && pp >= 0) out.pointsPossible = Math.round(pp);
  const aa = Number(rec.allowedAttempts);
  if (Number.isFinite(aa) && (aa === -1 || aa >= 1)) out.allowedAttempts = Math.round(aa);
  if (rec.promptMode === 'text' || rec.promptMode === 'decks' || rec.promptMode === 'youtube') {
    out.promptMode = rec.promptMode;
  }
  if (rec.signToVoiceRequired === true) out.signToVoiceRequired = true;
  if (Array.isArray(rec.prompts)) {
    const prompts = rec.prompts.map((p) => String(p ?? '').trim()).filter(Boolean);
    if (prompts.length) out.prompts = prompts;
  }
  if (isPlainObject(rec.videoPromptConfig)) {
    const v = rec.videoPromptConfig as Record<string, unknown>;
    const decks = Array.isArray(v.selectedDecks)
      ? (v.selectedDecks as unknown[])
          .map((d) => {
            if (!isPlainObject(d)) return null;
            const id = String((d as { id?: unknown }).id ?? '').trim();
            const title = String((d as { title?: unknown }).title ?? '').trim();
            if (!id) return null;
            return { id, title: title || id };
          })
          .filter((x): x is { id: string; title: string } => x != null)
      : [];
    const banks = Array.isArray(v.storedPromptBanks) ? (v.storedPromptBanks as unknown[]) : [];
    const hasBankRows = banks.some((b) => Array.isArray(b) && b.length > 0);
    const staticArr = Array.isArray(v.staticFallbackPrompts) ? (v.staticFallbackPrompts as unknown[]) : [];
    const hasStatic = staticArr.length > 0;
    const hasAnyDeckBody = decks.length > 0 || hasBankRows || hasStatic;
    let totalCards = Math.floor(Number(v.totalCards));
    if (hasAnyDeckBody) {
      if (!Number.isFinite(totalCards) || totalCards < 1) {
        if (decks.length > 0) {
          totalCards = 10;
        } else if (hasBankRows) {
          const lens = banks
            .filter((b): b is unknown[] => Array.isArray(b) && b.length > 0)
            .map((b) => b.length);
          totalCards = Math.max(1, ...lens, 1);
        } else {
          totalCards = 10;
        }
      }
      if (decks.length > 0) {
        out.videoPromptConfig = {
          selectedDecks: decks,
          totalCards,
          ...(Array.isArray(v.storedPromptBanks) ? { storedPromptBanks: v.storedPromptBanks as never } : {}),
          ...(Array.isArray(v.staticFallbackPrompts)
            ? {
                staticFallbackPrompts: (v.staticFallbackPrompts as unknown[])
                  .map((x) => String(x ?? '').trim())
                  .filter(Boolean),
              }
            : {}),
        };
      } else if (hasBankRows || hasStatic) {
        // Banks-only or static-only deck-shaped configs (legacy / partial embeds)
        out.videoPromptConfig = {
          selectedDecks: [],
          totalCards,
          ...(Array.isArray(v.storedPromptBanks) ? { storedPromptBanks: v.storedPromptBanks as never } : {}),
          ...(Array.isArray(v.staticFallbackPrompts)
            ? {
                staticFallbackPrompts: (v.staticFallbackPrompts as unknown[])
                  .map((x) => String(x ?? '').trim())
                  .filter(Boolean),
              }
            : {}),
        };
      }
    }
  }
  if (isPlainObject(rec.youtubePromptConfig)) {
    const y = rec.youtubePromptConfig as Record<string, unknown>;
    const videoId = String(y.videoId ?? '').trim();
    let clipStartSec = Math.floor(Number(y.clipStartSec));
    if (!Number.isFinite(clipStartSec) || clipStartSec < 0) clipStartSec = 0;
    let clipEndSec = Math.floor(Number(y.clipEndSec));
    if (!Number.isFinite(clipEndSec) || clipEndSec <= clipStartSec) {
      const legacy = Math.floor(Number(y.durationSec));
      if (Number.isFinite(legacy) && legacy >= 1) clipEndSec = clipStartSec + legacy;
      else clipEndSec = clipStartSec + 60;
    }
    if (videoId) {
      let heightPercent = Math.floor(Number((y.subtitleMask as { heightPercent?: unknown } | undefined)?.heightPercent));
      if (!Number.isFinite(heightPercent)) heightPercent = 15;
      heightPercent = Math.min(30, Math.max(5, heightPercent));
      out.youtubePromptConfig = {
        videoId,
        clipStartSec,
        clipEndSec,
        allowStudentCaptions: y.allowStudentCaptions === true,
        subtitleMask: {
          enabled: !!(y.subtitleMask as { enabled?: unknown } | undefined)?.enabled,
          heightPercent,
        },
        ...(y.label != null && String(y.label).trim() ? { label: String(y.label).trim() } : {}),
      };
    }
  }
  return out;
}

/**
 * Coerce arbitrary JSON (including mildly corrupted exports) into a usable Prompt Manager settings blob.
 */
export function repairPromptManagerSettingsBlobFromUnknown(input: unknown): {
  blob: PromptManagerSettingsBlob;
  notes: string[];
} {
  const notes: string[] = [];
  let raw: unknown = input;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) {
      return { blob: { v: 1, configs: {}, updatedAt: new Date().toISOString() }, notes: ['empty_string'] };
    }
    try {
      raw = JSON.parse(t) as unknown;
      notes.push('unwrapped_json_string');
    } catch {
      return { blob: { v: 1, configs: {}, updatedAt: new Date().toISOString() }, notes: ['invalid_json_string'] };
    }
  }
  if (!isPlainObject(raw)) {
    return { blob: { v: 1, configs: {}, updatedAt: new Date().toISOString() }, notes: ['root_not_object'] };
  }
  const o = raw;
  let v = o.v;
  if (typeof v !== 'number' || !Number.isFinite(v) || v !== 1) {
    if (v != null) notes.push(`normalized_v_was_${String(v)}`);
    v = 1;
  }
  const configs: Record<string, PromptConfigJson> = {};
  const rawConfigs = o.configs;
  if (rawConfigs == null) {
    notes.push('configs_missing');
  } else if (Array.isArray(rawConfigs)) {
    notes.push('configs_repaired_from_array');
    for (const item of rawConfigs) {
      if (!isPlainObject(item)) continue;
      const aid = String(
        item.assignmentId ?? item.id ?? item.canvasAssignmentId ?? item.assignment_id ?? '',
      ).trim();
      if (!aid || !/^\d+$/.test(aid)) continue;
      const cfg = sanitizePromptConfigJson(item);
      if (Object.keys(cfg).length > 0) configs[aid] = cfg;
    }
  } else if (isPlainObject(rawConfigs)) {
    for (const [k0, val] of Object.entries(rawConfigs)) {
      const k = String(k0).trim();
      if (!k) continue;
      if (!isPlainObject(val)) {
        notes.push(`skipped_non_object_config_${k.slice(0, 16)}`);
        continue;
      }
      configs[k] = sanitizePromptConfigJson(val);
    }
  } else {
    notes.push('configs_invalid_type');
  }
  let resourceLinkAssignmentMap: Record<string, string> | undefined;
  const rlm = o.resourceLinkAssignmentMap;
  if (isPlainObject(rlm)) {
    const m: Record<string, string> = {};
    for (const [a, b] of Object.entries(rlm)) {
      const ka = String(a).trim();
      const vb = String(b ?? '').trim();
      if (ka && vb) m[ka] = vb;
    }
    if (Object.keys(m).length > 0) resourceLinkAssignmentMap = m;
  }
  let configuredAssignmentIds: string[] | undefined;
  const cids = o.configuredAssignmentIds;
  if (Array.isArray(cids)) {
    const ids = cids.map((x) => String(x ?? '').trim()).filter((id) => /^\d+$/.test(id));
    if (ids.length > 0) configuredAssignmentIds = [...new Set(ids)];
  }

  const blob: PromptManagerSettingsBlob = {
    v: 1,
    configs,
    ...(resourceLinkAssignmentMap ? { resourceLinkAssignmentMap } : {}),
    ...(configuredAssignmentIds ? { configuredAssignmentIds } : {}),
    updatedAt: new Date().toISOString(),
  };
  return { blob, notes };
}
