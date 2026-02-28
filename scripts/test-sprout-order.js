/**
 * Quick test: SproutVideo playlists with order_by=updated_at
 * Run from project root: node scripts/test-sprout-order.js
 */
require('dotenv').config();

const apiKey = process.env.SPROUT_KEY;
if (!apiKey) {
  console.error('SPROUT_KEY not set in .env');
  process.exit(1);
}

const url = 'https://api.sproutvideo.com/v1/playlists?order_by=updated_at&order_dir=desc&per_page=3';

console.log('Testing:', url);
console.log('');

fetch(url, {
  headers: { 'SproutVideo-Api-Key': apiKey },
})
  .then((res) => {
    console.log('Status:', res.status, res.statusText);
    return res.json();
  })
  .then((data) => {
    if (data.error) {
      console.log('API Error:', data);
      return;
    }
    const playlists = data.playlists ?? [];
    console.log('Total playlists:', data.total ?? '?');
    console.log('Returned:', playlists.length);
    console.log('');
    playlists.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.title} (id=${p.id})`);
      console.log(`     updated_at: ${p.updated_at ?? '(not present)'}`);
      console.log(`     videos: ${p.videos ? p.videos.length + ' ids' : '(not present)'}`);
    });
    console.log('');
    console.log('Raw first playlist keys:', Object.keys(playlists[0] ?? {}));
  })
  .catch((err) => console.error('Fetch error:', err));
