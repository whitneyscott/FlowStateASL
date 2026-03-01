#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';
import { strict as assert } from 'assert';

function read(pathParts: string[]): string {
  const p = join(process.cwd(), ...pathParts);
  return readFileSync(p, 'utf8');
}

function run(): void {
  const flashcardController = read(['apps', 'api', 'src', 'flashcard', 'flashcard.controller.ts']);
  const canvasService = read(['apps', 'api', 'src', 'canvas', 'canvas.service.ts']);
  const webFlashcardsPage = read(['apps', 'web', 'src', 'pages', 'FlashcardsPage.tsx']);
  const teacherSettings = read(['apps', 'web', 'src', 'components', 'TeacherSettings.tsx']);
  const playlistCache = read(['apps', 'api', 'src', 'sproutvideo', 'playlist-cache.service.ts']);

  // Route guard + role hardening expectations.
  assert(
    flashcardController.includes('@UseGuards(LtiLaunchGuard)'),
    'FlashcardController must be protected by LtiLaunchGuard',
  );
  assert(
    flashcardController.includes('private requireTeacher('),
    'FlashcardController should enforce teacher role checks for teacher endpoints',
  );

  // Legacy routes/methods removed.
  assert(
    !flashcardController.includes("@Get('module-suggestion')"),
    'Legacy /flashcard/module-suggestion route must not exist',
  );
  assert(
    !canvasService.includes('findAssignmentByName('),
    'Deprecated CanvasService.findAssignmentByName must be removed',
  );
  assert(
    !canvasService.includes('createSubmissionWithComment('),
    'Deprecated CanvasService.createSubmissionWithComment must be removed',
  );

  // Frontend must use hierarchical DB-backed flow, not generic playlists endpoint.
  assert(
    !webFlashcardsPage.includes('/api/flashcard/playlists'),
    'FlashcardsPage must not call legacy /api/flashcard/playlists',
  );

  // Teacher settings no longer relies on stale flags/labels.
  assert(
    !teacherSettings.includes('needsUpdate'),
    'TeacherSettings should not rely on stale needsUpdate state',
  );
  assert(
    !teacherSettings.includes('/api/flashcard/all-playlists'),
    'TeacherSettings debug labels should not reference legacy all-playlists endpoint',
  );

  // Playlist filtering should be query-driven.
  assert(
    playlistCache.includes('LOWER(title) LIKE'),
    'PlaylistCacheService.getPlaylistsForFilter should use SQL prefix filtering',
  );
  assert(
    !playlistCache.includes('const all = await this.getAllPlaylists();'),
    'PlaylistCacheService.getPlaylistsForFilter should not full-scan in memory',
  );

  console.log('Regression checks passed: flashcard routes and DB-alignment invariants hold.');
}

try {
  run();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Regression checks failed: ${message}`);
  process.exit(1);
}
