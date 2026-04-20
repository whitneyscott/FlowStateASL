import { appendLtiLog } from '../common/last-error.store';
import type { CanvasService } from '../canvas/canvas.service';

export const FLASHCARD_SETTINGS_ASSIGNMENT_TITLE = 'Flashcard Settings';

export interface FlashcardSettingsBlob {
  v?: number;
  selectedCurriculums: string[];
  selectedUnits: string[];
  updatedAt?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Coerce arbitrary JSON into a valid flashcard settings shape (never throws). */
export function repairFlashcardSettingsBlobFromUnknown(input: unknown): FlashcardSettingsBlob {
  const now = new Date().toISOString();
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return { v: 1, selectedCurriculums: [], selectedUnits: [], updatedAt: now };
    }
  }
  if (!isPlainObject(raw)) {
    return { v: 1, selectedCurriculums: [], selectedUnits: [], updatedAt: now };
  }
  const o = raw;
  const toStrArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
  };
  let curricula = toStrArray(o.selectedCurriculums);
  let units = toStrArray(o.selectedUnits);
  if (!curricula.length && !units.length) {
    const legacy = o.selection;
    if (Array.isArray(legacy)) {
      curricula = legacy.map((x) => String(x ?? '').trim()).filter(Boolean);
    }
  }
  const vNum = Number(o.v);
  return {
    v: Number.isFinite(vNum) && vNum >= 1 ? Math.floor(vNum) : 1,
    selectedCurriculums: curricula,
    selectedUnits: units,
    updatedAt: typeof o.updatedAt === 'string' && o.updatedAt.trim() ? o.updatedAt.trim() : now,
  };
}

function extractFlashcardSettingsFromCanvasContent(raw: string): FlashcardSettingsBlob | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const tryOne = (s: string): FlashcardSettingsBlob | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      return repairFlashcardSettingsBlobFromUnknown(parsed);
    } catch {
      return null;
    }
  };
  return tryOne(trimmed) ?? (() => {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    return jsonMatch ? tryOne(jsonMatch[0]) : null;
  })();
}

async function ensureFlashcardSettingsAssignmentId(
  canvas: CanvasService,
  courseId: string,
  canvasDomain: string | undefined,
  token: string | null,
): Promise<string> {
  const existing = await canvas.findAssignmentByTitle(
    courseId,
    FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
    canvasDomain,
    token,
  );
  if (existing) return existing;

  let assignmentGroupId: number | undefined;
  try {
    assignmentGroupId = await canvas.ensureAssignmentGroup(
      courseId,
      FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
      0,
      canvasDomain,
      token,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('403')) {
      assignmentGroupId = undefined;
    } else {
      throw err;
    }
  }
  const createOpts: Parameters<CanvasService['createAssignment']>[2] = {
    submissionTypes: ['online_text_entry'],
    pointsPossible: 0,
    published: true,
    description: JSON.stringify({
      v: 1,
      selectedCurriculums: [] as string[],
      selectedUnits: [] as string[],
      updatedAt: new Date().toISOString(),
    }),
    omitFromFinalGrade: true,
    tokenOverride: token,
  };
  if (typeof assignmentGroupId === 'number') {
    createOpts.assignmentGroupId = assignmentGroupId;
  }
  return canvas.createAssignment(
    courseId,
    FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
    createOpts,
    canvasDomain,
  );
}

export async function readFlashcardSettingsBlobFromCanvas(
  canvas: CanvasService,
  courseId: string,
  domainOverride: string | undefined,
  token: string,
): Promise<FlashcardSettingsBlob | null> {
  const settingsAssignmentId = await canvas.findAssignmentByTitle(
    courseId,
    FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
    domainOverride,
    token,
  );
  if (settingsAssignmentId) {
    const assignment = await canvas.getAssignment(courseId, settingsAssignmentId, domainOverride, token);
    const raw = assignment?.description?.trim() ?? '';
    const blob = extractFlashcardSettingsFromCanvasContent(raw);
    if (blob) {
      return blob;
    }
  }
  const ann = await canvas.findFlashcardSettingsAnnouncement(courseId, token, domainOverride);
  if (ann?.message?.trim()) {
    const parsed = extractFlashcardSettingsFromCanvasContent(ann.message);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

async function upsertFlashcardSettingsAnnouncement(
  canvas: CanvasService,
  courseId: string,
  payload: { selectedCurriculums: string[]; selectedUnits: string[] },
  token: string | null,
  canvasOverride?: string,
): Promise<void> {
  const existing = await canvas.findFlashcardSettingsAnnouncement(courseId, token, canvasOverride);
  if (existing) {
    await canvas.updateFlashcardSettingsAnnouncement(courseId, existing.id, payload, token, canvasOverride);
  } else {
    await canvas.createFlashcardSettingsAnnouncement(courseId, payload, token, canvasOverride);
  }
}

export async function writeFlashcardSettingsBlobToCanvas(
  canvas: CanvasService,
  args: {
    courseId: string;
    domainOverride: string | undefined;
    token: string;
    blob: FlashcardSettingsBlob;
  },
): Promise<void> {
  const { courseId, domainOverride, token } = args;
  const payload: FlashcardSettingsBlob = {
    v: args.blob.v ?? 1,
    selectedCurriculums: args.blob.selectedCurriculums ?? [],
    selectedUnits: args.blob.selectedUnits ?? [],
    updatedAt: args.blob.updatedAt ?? new Date().toISOString(),
  };
  const settingsAssignmentId = await ensureFlashcardSettingsAssignmentId(canvas, courseId, domainOverride, token);
  const description = JSON.stringify(payload);
  await canvas.updateAssignmentDescription(courseId, settingsAssignmentId, description, domainOverride, token);
  try {
    await upsertFlashcardSettingsAnnouncement(
      canvas,
      courseId,
      {
        selectedCurriculums: payload.selectedCurriculums,
        selectedUnits: payload.selectedUnits,
      },
      token,
      domainOverride,
    );
  } catch (e) {
    appendLtiLog('course-settings', 'writeFlashcardSettingsBlobToCanvas: announcement upsert failed', {
      courseId,
      error: String(e),
    });
    throw e;
  }
}
