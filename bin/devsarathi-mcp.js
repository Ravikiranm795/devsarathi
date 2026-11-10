#!/usr/bin/env node
'use strict';
require('../packages/mcp/dist/index.js').main().catch((err) => {
  console.error(`devsarathi-mcp: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
