import { appendLtiLog } from '../common/last-error.store';
import type { CanvasService } from '../canvas/canvas.service';

export const FLASHCARD_SETTINGS_ASSIGNMENT_TITLE = 'Flashcard Settings';

export interface FlashcardSettingsBlob {
  v?: number;
  selectedCurriculums: string[];
  selectedUnits: string[];
  updatedAt?: string;
}

function extractFlashcardSettingsFromCanvasContent(raw: string): FlashcardSettingsBlob | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as FlashcardSettingsBlob;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as FlashcardSettingsBlob;
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
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
    if (blob && Array.isArray(blob.selectedCurriculums) && Array.isArray(blob.selectedUnits)) {
      return {
        v: blob.v ?? 1,
        selectedCurriculums: blob.selectedCurriculums,
        selectedUnits: blob.selectedUnits,
        updatedAt: blob.updatedAt,
      };
    }
  }
  const ann = await canvas.findFlashcardSettingsAnnouncement(courseId, token, domainOverride);
  if (ann?.message?.trim()) {
    const parsed = extractFlashcardSettingsFromCanvasContent(ann.message);
    if (parsed && Array.isArray(parsed.selectedCurriculums) && Array.isArray(parsed.selectedUnits)) {
      return {
        v: parsed.v ?? 1,
        selectedCurriculums: parsed.selectedCurriculums,
        selectedUnits: parsed.selectedUnits,
        updatedAt: parsed.updatedAt,
      };
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
