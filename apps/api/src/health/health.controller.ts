import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { getBuildMetadata } from '../common/build-metadata';

@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async getHealth() {
    const { gitCommit, gitCommitShort, source } = getBuildMetadata();
    let db: { ok: boolean; error?: string } = { ok: true };
    try {
      await this.dataSource.query('SELECT 1');
    } catch (err) {
      db = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return {
      ok: db.ok,
      gitCommit,
      gitCommitShort,
      gitCommitSource: source,
      nodeEnv: process.env.NODE_ENV ?? '(unset)',
      db,
    };
  }
}
