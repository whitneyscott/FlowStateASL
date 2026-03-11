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
    canvasBaseUrl?: string,
    tokenOverride?: string | null,
  ): Promise<boolean> {
    const trimmed = resourceLinkTitle?.trim() ?? '';
    if (!trimmed) return false;

    const config = await this.configRepo.getConfig(courseId, resourceLinkId);
    if (!config) return false;

    const stored = config.resourceLinkTitle?.trim() ?? '';
    if (stored === trimmed) return false;

    const newName = `${trimmed} - Submission`;
    const domainOverride = canvasBaseUrl ?? (canvasDomain ? `https://${canvasDomain}` : undefined);
    await this.canvasService.renameAssignment(
      courseId,
      assignmentId,
      newName,
      domainOverride,
      tokenOverride,
    );

    const updated: Parameters<IConfigRepository['saveConfig']>[0] = {
      ...config,
      resourceLinkTitle: trimmed,
    };
    await this.configRepo.saveConfig(updated);
    return true;
  }
}
