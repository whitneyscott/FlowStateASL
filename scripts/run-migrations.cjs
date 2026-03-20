/**
 * Run TypeORM migrations against the compiled Nest API data source.
 * Tries both dist layouts (Nx may emit under dist/apps/api/src/ or dist/apps/api/).
 * Use as Render pre-deploy: node scripts/run-migrations.cjs
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const candidates = [
  path.join(root, 'dist/apps/api/src/data/data-source.js'),
  path.join(root, 'dist/apps/api/data/data-source.js'),
];

let dataSource = candidates.find((p) => fs.existsSync(p));
if (!dataSource) {
  console.error(
    '[run-migrations] No compiled data-source.js found. Checked:\n',
    candidates.map((p) => '  - ' + path.relative(root, p)).join('\n'),
  );
  process.exit(1);
}

console.log('[run-migrations] Using data source:', path.relative(root, dataSource));

const result = spawnSync(
  'npx',
  ['typeorm', 'migration:run', '-d', dataSource],
  { stdio: 'inherit', shell: true, cwd: root },
);

process.exit(result.status === null ? 1 : result.status);
