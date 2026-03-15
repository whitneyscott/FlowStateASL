#!/usr/bin/env node
/**
 * Fetches raw Canvas submissions for course 1, assignment 106.
 * Add DEBUG_CANVAS_TOKEN to .env (Canvas Profile > Settings > + New Access Token), then run:
 *   node scripts/fetch-submission-raw.mjs
 */
import 'dotenv/config';

const token = process.env.DEBUG_CANVAS_TOKEN?.trim();
const base = (process.env.CANVAS_API_BASE_URL || 'http://localhost').replace(/\/$/, '');
const url = `${base}/api/v1/courses/1/assignments/106/submissions?include[]=user&include[]=submission_comments&include[]=submission_history&per_page=100`;

if (!token) {
  console.error('Add DEBUG_CANVAS_TOKEN to .env (Canvas Profile > Settings > + New Access Token)');
  process.exit(1);
}

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
});
const data = await res.json();
if (!res.ok) {
  console.error('Canvas API error:', res.status, JSON.stringify(data, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
