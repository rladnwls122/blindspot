// Runs the compiled tests with an explicit file list.
//
// `node --test <dir>` works on Node 20 and is rejected on Node 22; a bare
// `node --test` on Node 22 also picks up the .ts sources under test/, which
// cannot run. Windows cmd does not expand globs, so a pattern in package.json
// is not portable either. Listing the files here is the one form every
// supported runtime and shell agrees on.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'test');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));
if (files.length === 0) {
  console.error(`no compiled tests in ${dir} — run \`npm run build\` first`);
  process.exit(1);
}
const { status } = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(status ?? 1);
