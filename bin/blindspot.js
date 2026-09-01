#!/usr/bin/env node
'use strict';

// Thin launcher so the compiled CLI can also be imported as a module.
const { main } = require('../out/src/cli/index.js');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`blindspot: ${(err && err.message) || String(err)}\n`);
    // A review tool that crashes must never be the reason a commit fails.
    process.exitCode = 0;
  });
