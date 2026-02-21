import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_REPOSITORY } from '../data/tokens';
import type { IConfigRepository } from '../data/interfaces/config-repository.interface';
import { CanvasService } from '../canvas/canvas.service';

@Injectable()
export class AssessmentService {
  constructor(
    @Inject(CONFIG_REPOSITORY) private readonly configRepo: IConfigRepository,
    private readonly canvasService: CanvasService,
  ) {}

  async syncAssignmentNameIfNeeded(
    courseId: string,
    assignmentId: string,
    resourceLinkId: string,
    resourceLinkTitle: string,
    canvasDomain?: string,
  ): Promise<boolean> {
    const trimmed = resourceLinkTitle?.trim() ?? '';
    if (!trimmed) return false;

    const config = await this.configRepo.getConfig(courseId, resourceLinkId);
    if (!config) return false;

    const stored = config.resourceLinkTitle?.trim() ?? '';
    if (stored === trimmed) return false;

    const newName = `${trimmed} - Submission`;
    await this.canvasService.renameAssignment(
      courseId,
      assignmentId,
      newName,
      canvasDomain,
    );

    const updated: Parameters<IConfigRepository['saveConfig']>[0] = {
      ...config,
      resourceLinkTitle: trimmed,
    };
    await this.configRepo.saveConfig(updated);
    return true;
  }
}
