#!/usr/bin/env node
'use strict';
require('../packages/cli/dist/index.js').main(process.argv).catch((err) => {
  console.error(`devsarathi: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
