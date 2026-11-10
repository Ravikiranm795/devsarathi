'use strict';
// Builds packages/vscode/devsarathi.vsix with the official packager (@vscode/vsce). The same file is what you publish to the
// Marketplace and what the npm package ships for `devsarathi vscode install`.
const path = require('path');
const { createVSIX } = require('@vscode/vsce');

const cwd = path.resolve(__dirname, '..', 'packages', 'vscode');
createVSIX({
  cwd,
  packagePath: path.join(cwd, 'devsarathi.vsix'),
  dependencies: false, // the extension has no runtime dependencies: only the vscode API and Node built-ins
  allowMissingRepository: true
})
  .then(() => console.log('wrote packages/vscode/devsarathi.vsix'))
  .catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
