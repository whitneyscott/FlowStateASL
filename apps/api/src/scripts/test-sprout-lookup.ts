/**
 * Test: list folder 309fd2b81d17ecbe and find video by title. Run from repo root.
 * npx tsx apps/api/src/scripts/test-sprout-lookup.ts
 */
import 'dotenv/config';

const FOLDER_ID = '309fd2b81d17ecbe';
const TITLE = 'asl_1_125_f54c1472-e10f-438e-85b9-f75e9e3e582d_1773592920947';

async function main() {
  const apiKey = process.env.SPROUT_KEY;
  if (!apiKey) throw new Error('SPROUT_KEY not in .env');
  const url = `https://api.sproutvideo.com/v1/videos?folder_id=${encodeURIComponent(FOLDER_ID)}&per_page=100&page=1`;
  const res = await fetch(url, { headers: { 'SproutVideo-Api-Key': apiKey } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = (await res.json()) as { videos?: Array<{ id?: string; title?: string; security_token?: string }> };
  const videos = data.videos ?? [];
  const target = TITLE.trim().toLowerCase();
  const found = videos.find((v) => (v.title ?? '').trim().toLowerCase() === target);
  if (found) {
    const embedUrl = found.security_token
      ? `https://videos.sproutvideo.com/embed/${found.id}/${found.security_token}`
      : `https://videos.sproutvideo.com/embed/${found.id}`;
    console.log('Found:', found.id, found.title, embedUrl);
  } else {
    console.log('Not found. Titles in folder:', videos.map((v) => v.title));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
