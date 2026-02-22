import { Injectable } from '@nestjs/common';
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
  ) {}

  async get(courseId: string): Promise<{
    selectedCurriculums: string[];
    selectedUnits: string[];
    progressAssignmentId: string | null;
  } | null> {
    const row = await this.repo.findOne({ where: { courseId } });
    if (!row) return null;
    return {
      selectedCurriculums: Array.isArray(row.selectedCurriculums)
        ? row.selectedCurriculums
        : [],
      selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
      progressAssignmentId: row.progressAssignmentId ?? null,
    };
  }

  async save(
    courseId: string,
    selectedCurriculums: string[],
    selectedUnits: string[],
    canvasDomain?: string,
  ): Promise<void> {
    const progressAssignmentId =
      await this.canvas.ensureFlashcardProgressAssignment(
        courseId,
        canvasDomain,
      );
    await this.repo.upsert(
      {
        courseId,
        selectedCurriculums: selectedCurriculums ?? [],
        selectedUnits: selectedUnits ?? [],
        progressAssignmentId,
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
    const id = await this.canvas.ensureFlashcardProgressAssignment(
      courseId,
      canvasDomain,
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
