'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseFile } = require('../src/parser');

// Found on a real repo: tree-sitter's node binding rejects any source string over its default 32 KB buffer with
// "Invalid argument", so every large file silently dropped out of the graph and lowered coverage.
test('a source file far larger than 32 KB parses and yields its symbols', () => {
  const body = [];
  for (let i = 0; i < 1500; i++) body.push(`function fn${i}(a, b) {\n  const total = a + b + ${i};\n  return total * 2;\n}\n`);
  const source = body.join('\n');
  assert.ok(source.length > 60 * 1024, 'fixture is larger than the old buffer');
  const parsed = parseFile('big.js', '.js', source);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.symbols.length, 1500);
  assert.ok(parsed.symbols.some((s) => s.name === 'fn1499'));
});
