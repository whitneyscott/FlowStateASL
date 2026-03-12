import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  IPromptDataRepository,
  AssignmentPrompt,
} from '../../interfaces/prompt-data-repository.interface';
import { AssignmentPromptEntity } from '../../../prompt/entities/assignment-prompt.entity';
import { StudentResetEntity } from '../../../prompt/entities/student-reset.entity';

@Injectable()
export class PgPromptDataRepository implements IPromptDataRepository {
  constructor(
    @InjectRepository(AssignmentPromptEntity)
    private readonly promptRepo: Repository<AssignmentPromptEntity>,
    @InjectRepository(StudentResetEntity)
    private readonly resetRepo: Repository<StudentResetEntity>,
  ) {}

  async saveAssignmentPrompt(prompt: {
    courseId: string;
    assignmentId: string;
    userId: string;
    resourceLinkId?: string;
    promptText: string;
  }): Promise<void> {
    const entity = this.promptRepo.create({
      courseId: prompt.courseId,
      assignmentId: prompt.assignmentId,
      userId: prompt.userId,
      resourceLinkId: prompt.resourceLinkId ?? '',
      promptText: prompt.promptText,
      createdAt: new Date(),
    });
    await this.promptRepo.upsert(entity, {
      conflictPaths: ['courseId', 'assignmentId', 'userId'],
    });
  }

  async getAssignmentPrompt(
    courseId: string,
    assignmentId: string,
    userId: string,
  ): Promise<AssignmentPrompt | null> {
    const row = await this.promptRepo.findOne({
      where: { courseId, assignmentId, userId },
    });
    return row
      ? {
          courseId: row.courseId,
          assignmentId: row.assignmentId,
          userId: row.userId,
          resourceLinkId: row.resourceLinkId,
          promptText: row.promptText,
          createdAt: row.createdAt,
        }
      : null;
  }

  async recordStudentReset(
    courseId: string,
    assignmentId: string,
    userId: string,
  ): Promise<void> {
    const entity = this.resetRepo.create({
      courseId,
      assignmentId,
      userId,
      resetAt: new Date(),
    });
    await this.resetRepo.upsert(entity, {
      conflictPaths: ['courseId', 'assignmentId', 'userId'],
    });
  }

  async isStudentReset(
    courseId: string,
    assignmentId: string,
    userId: string,
  ): Promise<boolean> {
    const row = await this.resetRepo.findOne({
      where: { courseId, assignmentId, userId },
    });
    return !!row;
  }

  async clearStudentReset(
    courseId: string,
    assignmentId: string,
    userId: string,
  ): Promise<void> {
    await this.resetRepo.delete({ courseId, assignmentId, userId });
  }
}
