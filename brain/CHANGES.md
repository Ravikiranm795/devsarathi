# Drishti (brain) — change log

Drishti is the owner's own project. This folder started as a **source-only copy** of
`D:\AI-brain` (project-brain 1.0.0, upstream commit `4313576`). `node_modules`, `dist`
(the win-x64 portable build) and `.git` were not copied. The original folder is untouched.

## Baseline (before any change)
- `npm ci --ignore-scripts && npm test` → **88 tests pass, 0 fail** (Node v24.21.0, Windows 11).
- `npm ci` *without* `--ignore-scripts` fails: the old lockfile entry for `better-sqlite3@13.0.3`
  lacks `gypfile:false`, so npm tries `node-gyp rebuild` (needs Visual Studio). `npm install`
  against the registry metadata does not. See docs/DEVIATIONS.md (D-DEV-07).

## Changes for DevSarathi
Each entry: what, why, spec reference.

### Host integration: secrets, storage location, coverage, offline embeddings
- `src/secrets.js` (new): `isSecretFile` + `redactSecrets`. Env/key/credential files are never read (path only, kept
  in `manifest.secretFiles`, found even when git-ignored); credential-shaped strings in ordinary source are masked
  before chunks, signatures and doc comments are stored (I-8). A core test keeps its patterns in parity with
  `packages/core/src/security/secretPatterns.ts`.
- `src/walker.js`: `walkProjectDetailed` also returns `secretFiles`, `skippedLarge` and `codeEligible` (the coverage
  denominator); `walkProject` keeps its old return value. Directory ignores now match `dir/` correctly.
- `src/config.js`: `registerBrainDirOverride(root, dir)` keeps the graph inside the repo's own state folder;
  `peekBrainsHome()` reads config without creating `~/.brains`; default ignore list gained `target`, `.angular`,
  `__pycache__`, `.venv`, `venv`, `.gradle`, `.idea`, `.claude` (MASTER 7.2).
- `src/buildBrain.js`: options `storeDir`, `repoId`, `viz`, `instructions` so a host can keep the repo clean (I-5);
  returns `coverage` (parsed/eligible code files, symbols, edge counts); per-file parse errors persist in the manifest
  so coverage stays right across incremental builds; calls `store.insertFacts` after `upsertFile`.
- `src/embedder.js`: model cache dir (`BRAIN_MODEL_DIR`), offline mode (`BRAIN_OFFLINE=1`) with a clear error,
  `prefetchModel()`, and a deterministic `BRAIN_EMBEDDER=fake` embedder for tests and CI only (D-DEV-01).
- `src/manifest.js`: `CONTENT_VERSION` 4 (redaction + facts table) forces one rebuild of older graphs.
- Files were normalized to LF line endings (`.gitattributes`: `eol=lf`).
- Baseline after these changes: **107 tests pass** (88 original + 19 framework tests).

### Framework-aware facts and impact couplings
**What**
- `src/frameworks.js` - `extractFrameworkFacts(relPath, ext, source)` returns
  `[{ symbolName, framework, role, detail, line }]` from regex/text scans (no new dependency; comments are
  blanked first so commented-out code is not a fact). Never throws, skips files over 400 KB, caps 1000 facts/file.
  Roles: Angular (`component`, `directive`, `pipe`, `service`, `module`, `injects` via constructor or `inject()`,
  `route`, `template-uses` / `template-pipe` from `.html` and inline templates); Java/Spring (`controller`, `service`,
  `repository`, `component`, `configuration`, `entity`, `injects` via field/setter/constructor/Lombok, `route` with
  class+method paths joined, `bean` with the produced type as detail); Python (Django `route`/`model`, FastAPI/Flask
  `route`, `Depends` -> `injects`); PHP (Laravel `Route::`, Symfony `#[Route]`, constructor/`app()` `injects`);
  and `dynamic` hints for all of them (reflection, `eval`, `getattr`, computed `require`/`import`, `window[x]`, ...).
- `src/graphStore.js` - new table `framework_facts` (+ indexes on `(role, detail)` and `file_id`), created by the
  `CREATE TABLE IF NOT EXISTS` schema bootstrap so existing brains gain it on open; rows cascade from `files`
  (so `deleteFile` / `clearAll` / the delete half of `upsertFile` clear them). Methods: `insertFacts(fileId, facts)`
  (details are secret-redacted, I-8), `getFactsForFile(relPath)`, `findFacts({ role, detail, framework, symbolName, fileId })`,
  `countFactsByRole()`.
- `src/frameworkImpact.js` - `frameworkCouplings(store, symbol)` -> `[{ relation, name, path, line, why }]` with
  relations `template-uses` (templates and their owning components, by templateUrl or sibling file name),
  `injected-by`, and `route`; `dynamicRiskFor(store, symbol)` -> `{ level: 'none'|'some'|'high', reasons }`.
- `test/frameworks.test.js` - per-framework extraction, store round trip + cascade + upgrade, couplings, risk
  levels, and a never-throws / size-bound fuzz test.

**Why** - the name-based call graph cannot see DI, templates or routes, so a blast-radius check on an injected
service or an Angular component reports "no dependents" and the agent edits it blind. These facts make those
couplings visible, and the `dynamic` facts mark where even they cannot be complete, so impact answers state
their own limits (MASTER 7.5 accuracy limits, 7.6 mandatory impact analysis).

**Wiring** - `buildBrain.js` calls `store.insertFacts(fileId, extractFrameworkFacts(relPath, ext, source))` right after
`upsertFile`, and `packages/core/src/graph/impact.ts` uses `frameworkCouplings` / `dynamicRiskFor` for its confidence
grade. Existing brains pick facts up through the `CONTENT_VERSION` 4 rebuild. Limits: name-based matching (two classes with one name are
conflated); Laravel `Route::prefix()->group()` prefixes and Angular attribute-selector directives are not resolved.

### Performance
- `src/vectorIndex.js` `addBatch`: grow the backing buffer geometrically instead of copying the whole array per file. A full
  build of a synthetic 1,500-file / 21k-symbol repo went from 33s to 14s (fake embedder, so model time is excluded).
