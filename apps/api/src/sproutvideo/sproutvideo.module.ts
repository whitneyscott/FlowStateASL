import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SproutVideoService } from './sproutvideo.service';
import { PlaylistSyncService } from './playlist-sync.service';
import { PlaylistCacheService } from './playlist-cache.service';
import { SproutPlaylistEntity } from './entities/sprout-playlist.entity';
import { SproutPlaylistVideoEntity } from './entities/sprout-playlist-video.entity';
import { SyncMetadataEntity } from './entities/sync-metadata.entity';
import { PlaylistSyncScheduler } from './playlist-sync.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SproutPlaylistEntity,
      SproutPlaylistVideoEntity,
      SyncMetadataEntity,
    ]),
  ],
  providers: [
    SproutVideoService,
    PlaylistSyncService,
    PlaylistCacheService,
    PlaylistSyncScheduler,
  ],
  exports: [SproutVideoService, PlaylistCacheService],
})
export class SproutVideoModule {}
