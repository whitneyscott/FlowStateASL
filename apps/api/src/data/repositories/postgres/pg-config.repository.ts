import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IConfigRepository, PromptConfig } from '../../interfaces/config-repository.interface';
import { PromptConfigEntity } from '../../../assessment/entities/prompt-config.entity';

@Injectable()
export class PgConfigRepository implements IConfigRepository {
  constructor(
    @InjectRepository(PromptConfigEntity)
    private readonly repo: Repository<PromptConfigEntity>,
  ) {}

  async getConfig(
    courseId: string,
    resourceLinkId: string,
  ): Promise<PromptConfig | null> {
    const row = await this.repo.findOne({
      where: { courseId, resourceLinkId },
    });
    return row
      ? {
          courseId: row.courseId,
          resourceLinkId: row.resourceLinkId,
          configJson: row.configJson,
          resourceLinkTitle: row.resourceLinkTitle ?? undefined,
          updatedAt: row.updatedAt,
        }
      : null;
  }

  async saveConfig(config: PromptConfig): Promise<void> {
    await this.repo.upsert(
      {
        courseId: config.courseId,
        resourceLinkId: config.resourceLinkId,
        configJson: config.configJson,
        resourceLinkTitle: config.resourceLinkTitle ?? null,
      },
      { conflictPaths: ['courseId', 'resourceLinkId'] },
    );
  }

  async deleteConfig(courseId: string, resourceLinkId: string): Promise<void> {
    await this.repo.delete({ courseId, resourceLinkId });
  }
}
