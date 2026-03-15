#!/usr/bin/env node
/**
 * Diagnostic: which .env vars are set/missing for FlowStateASL.
 * Run: node scripts/check-env.mjs
 */
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });

const required = [
  'DATABASE_URL',
  'LTI_REDIRECT_URI',
  'LTI_PROMPTER_CLIENT_ID',
  'CANVAS_OAUTH_CLIENT_ID',
  'CANVAS_OAUTH_CLIENT_SECRET',
  'CANVAS_OAUTH_REDIRECT_URI',
];

const urlsMustBeLocalhost = ['APP_URL', 'LTI_REDIRECT_URI', 'FRONTEND_URL', 'CANVAS_OAUTH_REDIRECT_URI'];
const badPatterns = ['trycloudflare', 'cloudflare.com'];

console.log('\n=== FlowStateASL .env check ===\n');

let hasError = false;
for (const key of required) {
  const v = process.env[key] || '';
  const set = v.length > 0;
  const masked = set ? v.slice(0, 20) + (v.length > 20 ? '...' : '') : '(empty)';
  const status = set ? 'OK' : 'MISSING';
  if (!set) hasError = true;
  console.log(`  ${status.padEnd(8)} ${key}=${masked}`);
}

console.log('\n  URL sanity (no Cloudflare):');
for (const key of urlsMustBeLocalhost) {
  const v = (process.env[key] || '').trim();
  if (!v) continue;
  const bad = badPatterns.some((p) => v.toLowerCase().includes(p));
  if (bad) {
    hasError = true;
    console.log(`  FAIL     ${key} contains Cloudflare URL`);
  } else {
    console.log(`  OK       ${key}`);
  }
}

const unused = ['VIEWER_BASE_URL'];
for (const key of unused) {
  const v = process.env[key];
  if (v && v.includes('cloudflare')) {
    console.log(`  WARN     ${key} is set (not used by FlowStateASL) but has Cloudflare - remove or fix`);
  }
}

console.log('\n  Optional but used:');
console.log(`  LTI_CLIENT_ID       ${process.env.LTI_CLIENT_ID ? 'set' : 'not set (use LTI_PROMPTER_CLIENT_ID for Prompter)'}`);
console.log(`  CANVAS_API_BASE_URL ${process.env.CANVAS_API_BASE_URL ? 'set' : 'not set (comes from LTI iss when launched)'}`);

console.log('\n=== npm run start:dev chain ===');
console.log('  1. run-s kill-ports start:dev:run');
console.log('  2. kill-port 3000 4200 9229');
console.log('  3. nx run-many -t serve --parallel=2  (api + web)\n');

process.exit(hasError ? 1 : 0);
