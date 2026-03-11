#!/usr/bin/env node
/**
 * Seed sprout_playlists and sprout_playlist_videos from QTI zip files in qtifiles/.
 * Run: npm run seed:qti
 * Requires: DATABASE_URL in .env
 */
import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource, In } from 'typeorm';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SproutPlaylistEntity } from '../sproutvideo/entities/sprout-playlist.entity';
import { SproutPlaylistVideoEntity } from '../sproutvideo/entities/sprout-playlist-video.entity';
import { parseQtiZip } from '../qti/qti-parser';

config();

const QTI_DIR = process.env.QTI_DIR ?? join(process.cwd(), 'qtifiles');

/** Parse dot-delimited title e.g. "TWA.01.01.Example Playlist Title" → curriculum, unit, section, deck_title */
function parsePlaylistTitle(title: string): { curriculum: string; unit: string; section: string; deckTitle: string } | null {
  const parts = String(title ?? '').split('.').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 4) {
    console.warn(`[seed-qti] Skipping playlist title with <4 segments: "${title}"`);
    return null;
  }
  return {
    curriculum: parts[0],
    unit: parts[1],
    section: parts[2],
    deckTitle: parts.slice(3).join('.'),
  };
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required. Set it in .env');
    process.exit(1);
  }

  if (!readdirSync(QTI_DIR, { withFileTypes: true }).some((d) => d.name.endsWith('.zip'))) {
    console.error(`No .zip files found in ${QTI_DIR}`);
    process.exit(1);
  }

  const ds = new DataSource({
    type: 'postgres',
    url: dbUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    entities: [SproutPlaylistEntity, SproutPlaylistVideoEntity],
    synchronize: false,
  });

  await ds.initialize();
  const playlistRepo = ds.getRepository(SproutPlaylistEntity);
  const videoRepo = ds.getRepository(SproutPlaylistVideoEntity);

  const zips = readdirSync(QTI_DIR).filter((f) => f.toLowerCase().endsWith('.zip'));
  const total = zips.length;
  console.log(`Found ${total} zip files in ${QTI_DIR}. Starting seed...`);
  const syncedAt = new Date();
  let playlistsCount = 0;
  let videosCount = 0;

  for (let idx = 0; idx < zips.length; idx++) {
    const zipName = zips[idx];
    const zipPath = join(QTI_DIR, zipName);
    let buf: Buffer;
    try {
      buf = readFileSync(zipPath);
    } catch (err) {
      console.warn(`Skip ${zipName}: ${(err as Error).message}`);
      continue;
    }

    const parsed = parseQtiZip(buf, zipName);
    if (!parsed || parsed.videos.length === 0) {
      console.warn(`Skip ${zipName}: could not parse or no videos`);
      continue;
    }

    const titleParsed = parsePlaylistTitle(parsed.title);
    if (!titleParsed) continue;

    try {
      await playlistRepo.upsert(
        {
          id: parsed.playlistId,
          title: parsed.title,
          curriculum: titleParsed.curriculum,
          unit: titleParsed.unit,
          section: titleParsed.section,
          deckTitle: titleParsed.deckTitle,
          sproutUpdatedAt: null,
          syncedAt,
        },
        { conflictPaths: ['id'] }
      );

      const existing = await videoRepo.find({
        where: { playlistId: parsed.playlistId },
        select: ['videoId'],
      });
      const existingIds = new Set(existing.map((e) => e.videoId));
      const currentIds = new Set(parsed.videos.map((v) => v.videoId));

      const toDelete = [...existingIds].filter((id) => !currentIds.has(id));
      if (toDelete.length > 0) {
        await videoRepo.delete({
          playlistId: parsed.playlistId,
          videoId: In(toDelete),
        });
      }

      for (let i = 0; i < parsed.videos.length; i++) {
        const v = parsed.videos[i];
        await videoRepo.upsert(
          {
            playlistId: parsed.playlistId,
            videoId: v.videoId,
            position: i,
            title: v.title,
            embedCode: null,
          },
          { conflictPaths: ['playlistId', 'videoId'] }
        );
        videosCount++;
      }

      playlistsCount++;
      const progress = idx + 1;
      if (progress % 10 === 0 || progress === total) {
        console.log(`[${progress}/${total}] Processed ${playlistsCount} playlists, ${videosCount} videos`);
      }
    } catch (err) {
      console.warn(`Error processing ${zipName}: ${(err as Error).message}`);
    }
  }

  await ds.destroy();
  console.log(`QTI seed complete: ${playlistsCount} playlists, ${videosCount} videos`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
