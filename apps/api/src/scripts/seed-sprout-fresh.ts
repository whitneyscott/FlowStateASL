#!/usr/bin/env node
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SproutPlaylistEntity } from '../sproutvideo/entities/sprout-playlist.entity';
import { SproutPlaylistVideoEntity } from '../sproutvideo/entities/sprout-playlist-video.entity';
import { SyncMetadataEntity } from '../sproutvideo/entities/sync-metadata.entity';
import { SproutVideoService } from '../sproutvideo/sproutvideo.service';
import { PlaylistSyncService } from '../sproutvideo/playlist-sync.service';

loadEnv();

const SYNC_METADATA_KEY_LAST_SYNC = 'last_sync_at';

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is required');
  }
  if (!process.env.SPROUT_KEY) {
    throw new Error('SPROUT_KEY is required');
  }

  const dataSource = new DataSource({
    type: 'postgres',
    url: dbUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    entities: [SproutPlaylistEntity, SproutPlaylistVideoEntity, SyncMetadataEntity],
    synchronize: false,
  });

  await dataSource.initialize();
  const playlistRepo = dataSource.getRepository(SproutPlaylistEntity);
  const videoRepo = dataSource.getRepository(SproutPlaylistVideoEntity);
  const syncMetaRepo = dataSource.getRepository(SyncMetadataEntity);

  console.log('Clearing existing Sprout cache tables...');
  await dataSource.query('DELETE FROM sprout_playlist_videos');
  await dataSource.query('DELETE FROM sprout_playlists');
  await syncMetaRepo.delete({ key: SYNC_METADATA_KEY_LAST_SYNC });
  console.log('Sprout cache reset complete. Starting full sync...');

  const configService = new ConfigService(process.env);
  const sproutVideoService = new SproutVideoService(configService);
  const syncService = new PlaylistSyncService(
    sproutVideoService,
    configService,
    playlistRepo,
    videoRepo,
    syncMetaRepo,
  );

  try {
    const result = await syncService.sync();
    console.log(
      `Fresh Sprout seed complete (${result.incremental ? 'incremental' : 'full'}): ` +
        `${result.playlists} playlists, ${result.videos} videos`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
