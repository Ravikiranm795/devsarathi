'use strict';
// After `tsc -b`: point `require("@devsarathi/<pkg>")` at the sibling package inside this same npm package.
// In the monorepo npm links workspaces into node_modules; an installed tarball has no such links, so the published
// JavaScript must not depend on them. Idempotent: running it twice changes nothing.
const fs = require('fs');
const path = require('path');

const packages = path.resolve(__dirname, '..', 'packages');
let changed = 0;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

for (const pkg of fs.readdirSync(packages)) {
  const dist = path.join(packages, pkg, 'dist');
  if (!fs.existsSync(dist)) continue;
  for (const file of walk(dist, [])) {
    const src = fs.readFileSync(file, 'utf8');
    const next = src.replace(/require\((["'])@devsarathi\/([a-z0-9-]+)\1\)/g, (_m, q, name) => {
      const target = path.join(packages, name, 'dist', 'index.js');
      let rel = path.relative(path.dirname(file), target).split(path.sep).join('/');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return `require(${q}${rel}${q})`;
    });
    if (next !== src) {
      fs.writeFileSync(file, next);
      changed++;
    }
  }
}
console.log(`relink: rewrote ${changed} file(s)`);
