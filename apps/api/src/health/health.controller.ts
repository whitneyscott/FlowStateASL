import { Controller, Get } from '@nestjs/common';
import { getBuildMetadata } from '../common/build-metadata';

@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    const { gitCommit, gitCommitShort, source } = getBuildMetadata();
    return {
      ok: true,
      gitCommit,
      gitCommitShort,
      gitCommitSource: source,
      nodeEnv: process.env.NODE_ENV ?? '(unset)',
    };
  }
}
