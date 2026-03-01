import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PlaylistSyncService } from './playlist-sync.service';

@Injectable()
export class PlaylistSyncScheduler {
  private readonly logger = new Logger(PlaylistSyncScheduler.name);

  constructor(private readonly syncService: PlaylistSyncService) {}

  @Cron('0 */6 * * *', { name: 'sprout-playlist-sync' })
  async handleCron(): Promise<void> {
    try {
      const result = await this.syncService.sync();
      this.logger.log(
        `SproutVideo sync complete (${result.incremental ? 'incremental' : 'full'}): ` +
          `${result.playlists} playlists, ${result.videos} videos`,
      );
    } catch (err) {
      this.logger.error('SproutVideo sync failed', err instanceof Error ? err.stack : String(err));
    }
  }
}
