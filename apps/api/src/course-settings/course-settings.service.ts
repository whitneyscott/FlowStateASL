import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsEntity } from './entities/course-settings.entity';

const FLASHCARD_SETTINGS_ASSIGNMENT_TITLE = 'Flashcard Settings';

interface SettingsAssignmentDescriptionData {
  v?: number;
  selectedCurriculums?: string[];
  selectedUnits?: string[];
  updatedAt?: string;
}

/** Extract JSON from Canvas assignment description (may be HTML-wrapped or escaped) */
function parseAssignmentDescription(description: string): SettingsAssignmentDescriptionData | null {
  const trimmed = description?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as SettingsAssignmentDescriptionData;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Canvas may return HTML-wrapped content; try to extract JSON
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as SettingsAssignmentDescriptionData;
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

@Injectable()
export class CourseSettingsService {
  constructor(
    @InjectRepository(CourseSettingsEntity)
    private readonly repo: Repository<CourseSettingsEntity>,
    private readonly canvas: CanvasService,
    private readonly config: ConfigService,
  ) {}

  private async ensureFlashcardSettingsAssignment(
    courseId: string,
    canvasDomain?: string,
    tokenOverride?: string | null,
  ): Promise<string> {
    const existing = await this.canvas.findAssignmentByTitle(
      courseId,
      FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
      canvasDomain,
      tokenOverride,
    );
    if (existing) return existing;

    return this.canvas.createAssignment(
      courseId,
      FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
      {
        submissionTypes: ['online_text_entry'],
        pointsPossible: 0,
        published: true,
        description: 'Stores flashcard curriculum and unit settings (auto-created by ASL Express)',
        omitFromFinalGrade: true,
        tokenOverride,
      },
      canvasDomain,
    );
  }

  async get(
    courseId: string,
    options?: { isTeacher?: boolean; canvasDomain?: string },
  ): Promise<{
    selectedCurriculums: string[];
    selectedUnits: string[];
    sproutAccountId?: string;
    progressAssignmentId: string | null;
    hasCanvasToken: boolean;
  } | null> {
    const row = await this.repo.findOne({ where: { courseId } });
    if (!row) return null;

    const hasCanvasToken = !!(row.canvasApiToken?.trim?.());
    const tokenOverride = row.canvasApiToken ?? this.config.get<string>('CANVAS_API_TOKEN') ?? null;
    const domainOverride = options?.canvasDomain ?? this.config.get<string>('CANVAS_DOMAIN');

    let settingsAssignmentId: string | null = null;
    try {
      settingsAssignmentId = await this.canvas.findAssignmentByTitle(
        courseId,
        FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
        domainOverride,
        tokenOverride,
      );
    } catch {
      settingsAssignmentId = null;
    }

    if (!settingsAssignmentId) {
      return {
        selectedCurriculums: Array.isArray(row.selectedCurriculums) ? row.selectedCurriculums : [],
        selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
        progressAssignmentId: row.progressAssignmentId ?? null,
        sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
        hasCanvasToken,
      };
    }

    try {
      const assignment = await this.canvas.getAssignment(
        courseId,
        settingsAssignmentId,
        domainOverride,
        tokenOverride,
      );
      if (!assignment?.description?.trim()) {
        return {
          selectedCurriculums: Array.isArray(row.selectedCurriculums) ? row.selectedCurriculums : [],
          selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
          progressAssignmentId: row.progressAssignmentId ?? null,
          sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
          hasCanvasToken,
        };
      }

      const parsed = parseAssignmentDescription(assignment.description);
      if (!parsed) {
        return {
          selectedCurriculums: Array.isArray(row.selectedCurriculums) ? row.selectedCurriculums : [],
          selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
          progressAssignmentId: row.progressAssignmentId ?? null,
          sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
          hasCanvasToken,
        };
      }

      const selectedCurriculums = Array.isArray(parsed.selectedCurriculums) ? parsed.selectedCurriculums : [];
      const selectedUnits = Array.isArray(parsed.selectedUnits) ? parsed.selectedUnits : [];

      return {
        selectedCurriculums,
        selectedUnits,
        sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
        progressAssignmentId: row.progressAssignmentId ?? null,
        hasCanvasToken,
      };
    } catch {
      return {
        selectedCurriculums: Array.isArray(row.selectedCurriculums) ? row.selectedCurriculums : [],
        selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
        progressAssignmentId: row.progressAssignmentId ?? null,
        sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
        hasCanvasToken,
      };
    }
  }

  async save(
    courseId: string,
    selectedCurriculums: string[],
    selectedUnits: string[],
    canvasDomain?: string,
    canvasApiToken?: string,
  ): Promise<void> {
    const row = await this.repo.findOne({ where: { courseId } });
    const effectiveToken =
      canvasApiToken !== undefined
        ? (canvasApiToken?.trim() || null)
        : (row?.canvasApiToken ?? this.config.get<string>('CANVAS_API_TOKEN') ?? null);
    if (!effectiveToken) {
      throw new Error(
        'Canvas API token is required to save deck configuration. Please enter your Canvas API token in the Canvas API Token field.',
      );
    }
    const settingsAssignmentId = await this.ensureFlashcardSettingsAssignment(
      courseId,
      canvasDomain,
      effectiveToken,
    );
    const progressAssignmentId = await this.canvas.ensureFlashcardProgressAssignment(
      courseId,
      canvasDomain,
      effectiveToken,
    );
    const tokenToSave =
      canvasApiToken !== undefined
        ? (canvasApiToken?.trim() || null)
        : (row?.canvasApiToken ?? null);

    const payload: SettingsAssignmentDescriptionData = {
      v: 1,
      selectedCurriculums: selectedCurriculums ?? [],
      selectedUnits: selectedUnits ?? [],
      updatedAt: new Date().toISOString(),
    };

    const description = JSON.stringify(payload);
    await this.canvas.updateAssignmentDescription(
      courseId,
      settingsAssignmentId,
      description,
      canvasDomain,
      effectiveToken,
    );

    await this.repo.upsert(
      {
        courseId,
        selectedCurriculums: selectedCurriculums ?? [],
        selectedUnits: selectedUnits ?? [],
        progressAssignmentId,
        canvasApiToken: tokenToSave,
      },
      { conflictPaths: ['courseId'] },
    );
  }

  async getEffectiveCanvasToken(courseId: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { courseId } });
    return row?.canvasApiToken ?? this.config.get<string>('CANVAS_API_TOKEN') ?? null;
  }

  async getProgressAssignmentId(
    courseId: string,
    canvasDomain?: string,
  ): Promise<string> {
    const row = await this.repo.findOne({ where: { courseId } });
    if (row?.progressAssignmentId) return row.progressAssignmentId;
    const token = row?.canvasApiToken ?? this.config.get<string>('CANVAS_API_TOKEN') ?? null;
    const id = await this.canvas.ensureFlashcardProgressAssignment(
      courseId,
      canvasDomain,
      token,
    );
    await this.repo.upsert(
      {
        courseId,
        selectedCurriculums: row?.selectedCurriculums ?? [],
        selectedUnits: row?.selectedUnits ?? [],
        progressAssignmentId: id,
      },
      { conflictPaths: ['courseId'] },
    );
    return id;
  }
}
