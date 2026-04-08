#!/usr/bin/env node

/**
 * Synthetic canary for pre-class submission pressure checks.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/canary-concurrent-submissions.mjs
 *
 * Optional full upload test:
 *   BASE_URL=http://localhost:3000 \
 *   COOKIE="connect.sid=..." \
 *   ASSIGNMENT_ID=12345 \
 *   VIDEO_PATH=./tmp/test.webm \
 *   CONCURRENCY=6 \
 *   node scripts/canary-concurrent-submissions.mjs
 */

import { readFile } from 'node:fs/promises';

const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const concurrency = Number.parseInt(process.env.CONCURRENCY ?? '6', 10) || 6;
const cookie = (process.env.COOKIE ?? '').trim();
const assignmentId = (process.env.ASSIGNMENT_ID ?? '').trim();
const videoPath = (process.env.VIDEO_PATH ?? '').trim();

async function healthCheck() {
  const started = Date.now();
  const res = await fetch(`${baseUrl}/api/health`);
  const ms = Date.now() - started;
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ms, body };
}

async function uploadOnce(i) {
  const data = await readFile(videoPath);
  const form = new FormData();
  form.append('video', new Blob([data], { type: 'video/webm' }), `canary_${i}.webm`);
  form.append('promptSnapshotHtml', `<p>canary-${i}</p>`);
  const started = Date.now();
  const res = await fetch(
    `${baseUrl}/api/prompt/upload-video?assignmentId=${encodeURIComponent(assignmentId)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        'x-idempotency-key': `canary-${Date.now()}-${i}`,
      },
      body: form,
    },
  );
  const ms = Date.now() - started;
  const json = await res.json().catch(() => ({}));
  return { idx: i, ok: res.ok, status: res.status, ms, json };
}

async function run() {
  const health = await healthCheck();
  console.log('[canary] health', health);

  if (!videoPath || !assignmentId || !cookie) {
    console.log(
      '[canary] upload test skipped (set VIDEO_PATH, ASSIGNMENT_ID, COOKIE to run concurrent submission canary).',
    );
    return;
  }

  const tasks = Array.from({ length: concurrency }, (_, i) => uploadOnce(i + 1));
  const results = await Promise.all(tasks);
  const ok = results.filter((r) => r.ok).length;
  const busy = results.filter((r) => r.status === 429 || r.status === 503).length;
  const failed = results.length - ok - busy;
  console.log('[canary] uploads', { total: results.length, ok, busy, failed });
  for (const r of results) {
    console.log('[canary] result', {
      idx: r.idx,
      status: r.status,
      ok: r.ok,
      ms: r.ms,
      message: r.json?.message ?? '(none)',
    });
  }
}

run().catch((err) => {
  console.error('[canary] failed', err);
  process.exit(1);
});

