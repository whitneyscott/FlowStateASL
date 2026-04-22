import { appendLtiLog } from '../common/last-error.store';
import type { CanvasService } from '../canvas/canvas.service';
import type { PromptConfigJson } from './dto/prompt-config.dto';
import { mergeAssignmentDescriptionWithEmbeds, parseAssignmentDescriptionForPromptManager } from './assignment-description-embed.util';
import { repairPromptManagerSettingsBlobFromUnknown } from './prompt-settings-blob-repair.util';

export interface PromptManagerSettingsBlob {
  v?: number;
  /**
   * Legacy monolithic per-assignment configs. After per-assignment migration, this is empty
   * and each assignment stores config in `assignment.description` ASL embed divs.
   */
  configs?: Record<string, PromptConfigJson>;
  resourceLinkAssignmentMap?: Record<string, string>;
  /** Denormalized list of assignment ids with embed-based PM config (thin course index). */
  configuredAssignmentIds?: string[];
  updatedAt?: string;
}

export const PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE = 'Prompt Manager Settings';
export const PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE = 'ASL Express Prompt Manager Settings';

/** When the settings assignment exists but the description is empty or not JSON, reads use this as a safe prior. */
function emptySettingsAssignmentReadFallback(): PromptManagerSettingsBlob {
  return { v: 1, configs: {}, updatedAt: new Date().toISOString() };
}

/** Extract JSON from Canvas assignment description or announcement body (may be HTML-wrapped). */
export function extractPromptManagerSettingsBlobFromCanvasContent(raw: string): PromptManagerSettingsBlob | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const tryParse = (json: string): PromptManagerSettingsBlob | null => {
    try {
      const parsed = JSON.parse(json) as unknown;
      const { blob, notes } = repairPromptManagerSettingsBlobFromUnknown(parsed);
      if (notes.length > 0) {
        appendLtiLog('prompt-import', 'extractPromptManagerSettingsBlob: repaired shape', {
          noteCount: notes.length,
          notes: notes.slice(0, 8),
        });
      }
      return blob;
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return tryParse(jsonMatch[0]);
  }
  return null;
}

/** Read a Prompt Manager settings blob from any Canvas assignment description (e.g. orphan "Settings" assignment). */
export async function readPromptManagerSettingsBlobFromCanvasAssignmentDescription(
  canvas: CanvasService,
  courseId: string,
  assignmentId: string,
  domainOverride: string | undefined,
  token: string,
): Promise<PromptManagerSettingsBlob | null> {
  const assignment = await canvas.getAssignment(courseId, assignmentId, domainOverride, token);
  const raw = assignment?.description?.trim() ?? '';
  return extractPromptManagerSettingsBlobFromCanvasContent(raw);
}

export async function ensurePromptManagerSettingsAssignmentId(
  canvas: CanvasService,
  courseId: string,
  domainOverride: string | undefined,
  token: string,
): Promise<string> {
  const existing = await canvas.findAssignmentByTitle(
    courseId,
    PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
    domainOverride,
    token,
  );
  if (existing) return existing;
  return canvas.createAssignment(
    courseId,
    PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
    {
      submissionTypes: ['online_text_entry'],
      pointsPossible: 0,
      published: true,
      description: 'Stores Prompt Manager config per assignment (auto-created by ASL Express)',
      omitFromFinalGrade: true,
      tokenOverride: token,
    },
    domainOverride,
  );
}

export async function readPromptManagerSettingsBlobFromCanvas(
  canvas: CanvasService,
  courseId: string,
  domainOverride: string | undefined,
  token: string,
): Promise<PromptManagerSettingsBlob | null> {
  let assignmentBlob: PromptManagerSettingsBlob | null = null;
  const settingsAssignmentId = await canvas.findAssignmentByTitle(
    courseId,
    PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
    domainOverride,
    token,
  );
  appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlobFromCanvas: after findAssignmentByTitle', {
    courseId,
    settingsAssignmentId: settingsAssignmentId ?? null,
  });
  if (settingsAssignmentId) {
    const assignment = await canvas.getAssignment(courseId, settingsAssignmentId, domainOverride, token);
    appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlobFromCanvas: after getAssignment', {
      courseId,
      settingsAssignmentId,
      assignmentFound: !!assignment,
      descriptionNonEmpty: Boolean((assignment?.description ?? '').trim()),
    });
    const raw = assignment?.description?.trim() ?? '';
    const blob = extractPromptManagerSettingsBlobFromCanvasContent(raw);
    if (!blob) {
      // Empty or non-JSON description: still a readable "no index" state. Returning null made
      // writePromptManagerSettingsBlobToCanvas safety-abort because prior looked unreadable.
      appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlobFromCanvas: settings description empty or unparseable; empty index', {
        courseId,
        settingsAssignmentId,
        hadRaw: Boolean((raw ?? '').length),
      });
      assignmentBlob = emptySettingsAssignmentReadFallback();
    } else {
      const configCount =
        blob.configs && typeof blob.configs === 'object' ? Object.keys(blob.configs).length : 0;
      const mapKeys = Object.keys(blob.resourceLinkAssignmentMap ?? {}).length;
      const idListLen = Array.isArray(blob.configuredAssignmentIds) ? blob.configuredAssignmentIds.length : 0;
      const isThinIndex = configCount === 0 && (mapKeys > 0 || idListLen > 0);
      appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlobFromCanvas: after extract (assignment)', {
        courseId,
        source: 'assignment_description',
        blobParsed: true,
        configCount,
        isThinIndex,
      });
      if (configCount > 0 || isThinIndex) return blob;
      assignmentBlob = blob;
    }
  }
  const ann = await canvas.findSettingsAnnouncementByTitle(
    courseId,
    PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE,
    token,
    domainOverride,
  );
  appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlobFromCanvas: after findSettingsAnnouncementByTitle', {
    courseId,
    announcementFound: !!ann,
    hasMessage: Boolean((ann?.message ?? '').trim()),
  });
  if (ann?.message) {
    const annBlob = extractPromptManagerSettingsBlobFromCanvasContent(ann.message);
    const annConfigCount =
      annBlob?.configs && typeof annBlob.configs === 'object' ? Object.keys(annBlob.configs).length : 0;
    const annMapKeys = Object.keys(annBlob?.resourceLinkAssignmentMap ?? {}).length;
    const annIdLen = Array.isArray(annBlob?.configuredAssignmentIds) ? annBlob.configuredAssignmentIds.length : 0;
    const annThin = annConfigCount === 0 && (annMapKeys > 0 || annIdLen > 0);
    appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlobFromCanvas: after extract (announcement)', {
      courseId,
      source: 'announcement',
      blobParsed: !!annBlob,
      configCount: annConfigCount,
    });
    if (annBlob && (annConfigCount > 0 || annThin)) {
      return annBlob;
    }
    if (annBlob) return annBlob;
  }
  return assignmentBlob;
}

/**
 * If the course index is thin (no `configs` in the settings JSON), rebuild a monolithic `configs` map
 * from each `configuredAssignmentId` by reading that assignment’s description embeds. Used for
 * export and cross-course import of migrated courses.
 */
export async function readPromptManagerSettingsBlobWithEmbedsResolved(
  canvas: CanvasService,
  courseId: string,
  domainOverride: string | undefined,
  token: string,
): Promise<PromptManagerSettingsBlob | null> {
  const base = await readPromptManagerSettingsBlobFromCanvas(canvas, courseId, domainOverride, token);
  if (!base) return null;
  if (Object.keys(base.configs ?? {}).length > 0) return base;
  const ids = base.configuredAssignmentIds;
  if (!Array.isArray(ids) || ids.length === 0) return base;
  const configs: Record<string, PromptConfigJson> = {};
  for (const aid of ids) {
    if (!/^\d+$/.test(String(aid))) continue;
    try {
      const a = await canvas.getAssignment(courseId, String(aid), domainOverride, token);
      const d = a?.description;
      if (typeof d !== 'string' || !d.trim()) continue;
      const p = parseAssignmentDescriptionForPromptManager(d);
      if (p.config) {
        configs[String(aid)] = { ...p.config, instructions: p.visibleHtml };
      }
    } catch {
      /* skip unreadable assignment */
    }
  }
  if (Object.keys(configs).length === 0) return base;
  return { ...base, v: base.v ?? 1, configs };
}

function isPlainConfigsMap(configs: unknown): configs is Record<string, PromptConfigJson> {
  return configs != null && typeof configs === 'object' && !Array.isArray(configs);
}

export async function writePromptManagerSettingsBlobToCanvas(
  canvas: CanvasService,
  args: {
    courseId: string;
    domainOverride: string | undefined;
    token: string;
    blob: PromptManagerSettingsBlob;
    /** When false, only update the Prompt Manager Settings assignment (default: true). */
    syncAnnouncement?: boolean;
    /** Allow reducing config count (use only for explicit delete/replace flows). */
    allowConfigShrink?: boolean;
  },
): Promise<void> {
  const { courseId, domainOverride, token, blob } = args;
  const syncAnnouncement = args.syncAnnouncement !== false;
  const allowConfigShrink = args.allowConfigShrink === true;

  const existingSettingsAssignmentId = await canvas.findAssignmentByTitle(
    courseId,
    PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
    domainOverride,
    token,
  );

  /**
   * Production safety: never persist when we could not read a valid prior `configs` map from Canvas
   * while a Prompt Manager Settings assignment already exists (avoids `{ ...null?.configs, [id]: x }` wipes).
   */
  let priorReadableBlob: PromptManagerSettingsBlob | null = null;
  if (existingSettingsAssignmentId) {
    try {
      priorReadableBlob = await readPromptManagerSettingsBlobFromCanvas(canvas, courseId, domainOverride, token);
    } catch (err) {
      appendLtiLog('prompt', 'writePromptManagerSettingsBlobToCanvas: SAFETY ABORT prior read threw', {
        courseId,
        settingsAssignmentId: existingSettingsAssignmentId,
        error: String(err),
      });
      throw new Error(
        'SAFETY ABORT: Refusing to write Prompt Manager Settings — ' +
          'reading the existing blob from Canvas failed with an exception. ' +
          'This write could destroy all configured assignment settings. ' +
          'Fix the read path (token, permissions, or Canvas availability) before retrying.',
      );
    }
    if (priorReadableBlob == null) {
      appendLtiLog('prompt', 'writePromptManagerSettingsBlobToCanvas: prior read null; treating as empty index', {
        courseId,
        settingsAssignmentId: existingSettingsAssignmentId,
      });
      priorReadableBlob = emptySettingsAssignmentReadFallback();
    }
    if (!isPlainConfigsMap(priorReadableBlob.configs)) {
      appendLtiLog('prompt', 'writePromptManagerSettingsBlobToCanvas: SAFETY ABORT unreadable prior blob', {
        courseId,
        settingsAssignmentId: existingSettingsAssignmentId,
        configsType: typeof priorReadableBlob.configs,
        configsIsArray: Array.isArray(priorReadableBlob?.configs),
      });
      throw new Error(
        'SAFETY ABORT: Refusing to write Prompt Manager Settings — ' +
          'existing blob read returned invalid `configs` shape. ' +
          'This write would destroy all configured assignment settings. ' +
          'Fix the read path before attempting any write.',
      );
    }
  } else if (!isPlainConfigsMap(blob.configs)) {
    appendLtiLog('prompt', 'writePromptManagerSettingsBlobToCanvas: SAFETY ABORT invalid incoming configs', {
      courseId,
      reason: 'bootstrap_requires_plain_configs_object',
      configsType: typeof blob.configs,
      configsIsArray: Array.isArray(blob.configs),
    });
    throw new Error(
      'SAFETY ABORT: Refusing to write Prompt Manager Settings — ' +
        'incoming blob is missing a plain object `configs` map (first write / bootstrap).',
    );
  }

  const existingConfigCount =
    priorReadableBlob && isPlainConfigsMap(priorReadableBlob.configs)
      ? Object.keys(priorReadableBlob.configs).length
      : 0;
  const incomingConfigCount = Object.keys(blob?.configs ?? {}).length;
  if (!allowConfigShrink && existingConfigCount > 0 && incomingConfigCount < existingConfigCount) {
    appendLtiLog('prompt', 'writePromptManagerSettingsBlobToCanvas: blocked shrink write', {
      courseId,
      existingConfigCount,
      incomingConfigCount,
    });
    throw new Error(
      `Refusing to overwrite Prompt Manager settings with fewer configs (${incomingConfigCount} < ${existingConfigCount}).`,
    );
  }

  const settingsAssignmentId =
    existingSettingsAssignmentId ??
    (await ensurePromptManagerSettingsAssignmentId(
      canvas,
      courseId,
      domainOverride,
      token,
    ));
  const description = JSON.stringify(blob);
  await canvas.updateAssignmentDescription(courseId, settingsAssignmentId, description, domainOverride, token);
  if (!syncAnnouncement) return;
  try {
    const ann = await canvas.findSettingsAnnouncementByTitle(
      courseId,
      PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE,
      token,
      domainOverride,
    );
    if (ann) {
      await canvas.updateSettingsAnnouncement(courseId, ann.id, description, token, domainOverride);
    } else {
      await canvas.createSettingsAnnouncement(
        courseId,
        `⚠️ DO NOT DELETE — ${PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE}`,
        description,
        token,
        domainOverride,
      );
    }
  } catch (annErr) {
    appendLtiLog('prompt', 'writePromptManagerSettingsBlobToCanvas: announcement sync failed (non-fatal)', {
      courseId,
      error: String(annErr),
    });
  }
}

/**
 * When the course still has a monolithic `configs` map in the Prompt Manager Settings JSON,
 * copy each entry into the corresponding assignment `description` as ASL hidden embeds, then
 * write a thin index (empty `configs`, `configuredAssignmentIds` populated). Idempotent for
 * already-migrated courses: no-op when `configs` is empty.
 */
export async function migrateMonolithicPromptBlobToPerAssignmentEmbeds(
  canvas: CanvasService,
  courseId: string,
  domainOverride: string | undefined,
  token: string,
): Promise<{ migrated: boolean; assignmentCount: number }> {
  const prior = await readPromptManagerSettingsBlobFromCanvas(canvas, courseId, domainOverride, token);
  const keys = prior?.configs && typeof prior.configs === 'object' ? Object.keys(prior.configs) : [];
  if (!prior || keys.length === 0) {
    return { migrated: false, assignmentCount: 0 };
  }
  let n = 0;
  for (const aid of keys) {
    const cfg = prior.configs![aid];
    if (!cfg) continue;
    const assign = await canvas.getAssignment(courseId, aid, domainOverride, token);
    const desc = typeof assign?.description === 'string' ? assign.description : '';
    const merged = mergeAssignmentDescriptionWithEmbeds(desc, cfg, cfg.prompts);
    try {
      await canvas.updateAssignment(
        courseId,
        aid,
        { description: merged },
        domainOverride,
        token,
      );
      n += 1;
    } catch (err) {
      appendLtiLog('prompt', 'migrateMonolithicPromptBlob: per-assignment PUT failed (skipping id)', {
        courseId,
        aid,
        error: String(err),
      });
    }
  }
  const configuredIds = [
    ...new Set([
      ...keys,
      ...((Array.isArray(prior.configuredAssignmentIds) ? prior.configuredAssignmentIds : []).map(String)),
    ]),
  ];
  const thin: PromptManagerSettingsBlob = {
    v: 1,
    configs: {},
    resourceLinkAssignmentMap: prior.resourceLinkAssignmentMap,
    configuredAssignmentIds: configuredIds,
    updatedAt: new Date().toISOString(),
  };
  await writePromptManagerSettingsBlobToCanvas(canvas, {
    courseId,
    domainOverride,
    token,
    blob: thin,
    allowConfigShrink: true,
  });
  appendLtiLog('prompt', 'migrateMonolithicPromptBlob: course index thinned', {
    courseId,
    assignmentsWritten: n,
    keyCount: keys.length,
  });
  return { migrated: true, assignmentCount: n };
}
