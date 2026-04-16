#!/usr/bin/env node
/**
 * Writes PROMPT_DATA metadata into a small WebM using ffmpeg, then prints ffprobe format/tags.
 *
 * Requires: ffmpeg and ffprobe on PATH.
 *
 * Usage: node test-metadata.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const INPUT = path.join(ROOT, 'asl_submission_1775500023.webm');
const OUTPUT = path.join(ROOT, 'test-with-metadata.webm');

const PROMPT_DATA = JSON.stringify({
  test: true,
  videoId: 'abc123',
  clipStartSec: 10,
  clipEndSec: 45,
});

function runOrThrow(cmd, args, label) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) {
    console.error(`[${label}] spawn error:`, r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[${label}] exit ${r.status}`);
    if (r.stderr) console.error(r.stderr);
    if (r.stdout) console.error(r.stdout);
    process.exit(r.status ?? 1);
  }
  return r;
}

if (!fs.existsSync(INPUT)) {
  console.error('Input WebM not found:', INPUT);
  process.exit(1);
}

if (fs.existsSync(OUTPUT)) {
  fs.unlinkSync(OUTPUT);
}

console.log('Input:', INPUT);
console.log('Output:', OUTPUT);
console.log('PROMPT_DATA:', PROMPT_DATA);
console.log('');

const ffmpegArgs = [
  '-y',
  '-i',
  INPUT,
  '-c',
  'copy',
  '-metadata',
  `PROMPT_DATA=${PROMPT_DATA}`,
  OUTPUT,
];
console.log('Running: ffmpeg', ...ffmpegArgs);
runOrThrow('ffmpeg', ffmpegArgs, 'ffmpeg');

console.log('\n========== ffprobe: full -show_format JSON ==========\n');
const probe = runOrThrow(
  'ffprobe',
  ['-v', 'quiet', '-print_format', 'json', '-show_format', OUTPUT],
  'ffprobe',
);

let parsed;
try {
  parsed = JSON.parse(probe.stdout);
} catch (e) {
  console.error('Failed to parse ffprobe JSON:', e);
  console.log(probe.stdout);
  process.exit(1);
}

console.log(JSON.stringify(parsed, null, 2));

console.log('\n========== ffprobe: format.tags (metadata) ==========\n');
const tags = parsed?.format?.tags;
if (tags && typeof tags === 'object') {
  console.log(JSON.stringify(tags, null, 2));
  const prompt = tags.PROMPT_DATA ?? tags['PROMPT_DATA'];
  if (prompt !== undefined) {
    console.log('\nPROMPT_DATA raw value:', prompt);
    try {
      console.log('PROMPT_DATA parsed JSON:', JSON.stringify(JSON.parse(prompt), null, 2));
    } catch {
      console.log('(Could not parse PROMPT_DATA as JSON — inspect raw string above)');
    }
  } else {
    console.log('PROMPT_DATA not found under format.tags; see full JSON above.');
  }
} else {
  console.log('No format.tags object present.');
}
