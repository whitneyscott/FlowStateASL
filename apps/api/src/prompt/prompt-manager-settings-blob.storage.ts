import { appendLtiLog } from '../common/last-error.store';
import type { CanvasService } from '../canvas/canvas.service';
import type { PromptConfigJson } from './dto/prompt-config.dto';
import { repairPromptManagerSettingsBlobFromUnknown } from './prompt-settings-blob-repair.util';

export interface PromptManagerSettingsBlob {
  v?: number;
  configs?: Record<string, PromptConfigJson>;
  resourceLinkAssignmentMap?: Record<string, string>;
  updatedAt?: string;
}

export const PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE = 'Prompt Manager Settings';
export const PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE = 'ASL Express Prompt Manager Settings';

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
    const configCount =
      blob?.configs && typeof blob.configs === 'object' ? Object.keys(blob.configs).length : 0;
    appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlobFromCanvas: after extract (assignment)', {
      courseId,
      source: 'assignment_description',
      blobParsed: !!blob,
      configCount,
    });
    if (blob && configCount > 0) return blob;
    assignmentBlob = blob;
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
    appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlobFromCanvas: after extract (announcement)', {
      courseId,
      source: 'announcement',
      blobParsed: !!annBlob,
      configCount: annConfigCount,
    });
    if (annBlob && annConfigCount > 0) {
      // Recovery path: prefer non-empty announcement blob when assignment blob is empty/corrupt.
      return annBlob;
    }
    if (annBlob) return annBlob;
  }
  return assignmentBlob;
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
  },
): Promise<void> {
  const { courseId, domainOverride, token, blob } = args;
  const syncAnnouncement = args.syncAnnouncement !== false;
  const settingsAssignmentId = await ensurePromptManagerSettingsAssignmentId(
    canvas,
    courseId,
    domainOverride,
    token,
  );
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
