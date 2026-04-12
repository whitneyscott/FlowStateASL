import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { VideoProxyGrantEntity } from './entities/video-proxy-grant.entity';

@Injectable()
export class VideoProxyGrantCleanupScheduler {
  private readonly logger = new Logger(VideoProxyGrantCleanupScheduler.name);

  constructor(
    @InjectRepository(VideoProxyGrantEntity)
    private readonly grantRepo: Repository<VideoProxyGrantEntity>,
  ) {}

  @Cron('*/15 * * * *', { name: 'video-proxy-grant-cleanup' })
  async purgeExpired(): Promise<void> {
    try {
      const r = await this.grantRepo.delete({ expiresAt: LessThan(new Date()) });
      const n = r.affected ?? 0;
      if (n > 0) {
        this.logger.log(`Removed ${n} expired video proxy grant(s)`);
      }
    } catch (err) {
      this.logger.error(
        'Video proxy grant cleanup failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
