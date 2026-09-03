#!/usr/bin/env node
'use strict';

// `node --test <dir>` recurses on Node 20 and refuses the directory on 22;
// `node --test <glob>` is expanded by the shell on Linux and by nobody on
// Windows. Listing the files here is the one form every combination runs.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = join(__dirname, '..', 'out', 'test');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join(dir, f));

if (files.length === 0) {
  process.stderr.write('run-tests: no compiled tests in out/test — run `npm run build` first\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
