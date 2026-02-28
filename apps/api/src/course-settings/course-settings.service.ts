import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsEntity } from './entities/course-settings.entity';

@Injectable()
export class CourseSettingsService {
  constructor(
    @InjectRepository(CourseSettingsEntity)
    private readonly repo: Repository<CourseSettingsEntity>,
    private readonly canvas: CanvasService,
    private readonly config: ConfigService,
  ) {}

  async get(courseId: string): Promise<{
    selectedCurriculums: string[];
    selectedUnits: string[];
    progressAssignmentId: string | null;
    hasCanvasToken: boolean;
  } | null> {
    const row = await this.repo.findOne({ where: { courseId } });
    console.log('[CourseSettingsService.get] courseId:', courseId, 'row:', row ? { selectedCurriculums: row.selectedCurriculums, selectedUnits: row.selectedUnits } : 'null');
    if (!row) return null;
    return {
      selectedCurriculums: Array.isArray(row.selectedCurriculums)
        ? row.selectedCurriculums
        : [],
      selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
      progressAssignmentId: row.progressAssignmentId ?? null,
      hasCanvasToken: !!(row.canvasApiToken?.trim?.()),
    };
  }

  async save(
    courseId: string,
    selectedCurriculums: string[],
    selectedUnits: string[],
    canvasDomain?: string,
    canvasApiToken?: string,
  ): Promise<void> {
    console.log('[CourseSettingsService.save] courseId:', courseId, 'selectedCurriculums:', selectedCurriculums, 'selectedUnits:', selectedUnits);
    const row = await this.repo.findOne({ where: { courseId } });
    const effectiveToken =
      canvasApiToken !== undefined
        ? (canvasApiToken?.trim() || null)
        : (row?.canvasApiToken ?? this.config.get<string>('CANVAS_API_TOKEN') ?? null);
    const progressAssignmentId =
      await this.canvas.ensureFlashcardProgressAssignment(
        courseId,
        canvasDomain,
        effectiveToken,
      );
    const tokenToSave =
      canvasApiToken !== undefined
        ? (canvasApiToken?.trim() || null)
        : (row?.canvasApiToken ?? null);
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
