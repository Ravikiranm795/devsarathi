---
paths: {{stackGlobs}}
---
# Node.js rules

- Never build a shell command from input: use `execFile`/`spawn` with an argument array, not `exec` with a template string. <!-- strict topic:shell -->
- Validate input at the boundary (CLI flags, request bodies, file contents) before it reaches the logic. <!-- strict topic:validation -->
- Handle every rejected promise: no floating promises, and `await` inside `try`/`catch` where failure is expected. <!-- strict topic:async -->
- Do not read `process.env` values into logs or error messages, and never hard-code credentials. <!-- strict topic:secrets -->
- Use `path.join`/`path.resolve` for file paths and reject paths that escape the intended folder. <!-- strict topic:paths -->
- Keep modules small and single-purpose; share code through exports, not globals. <!-- default topic:layering -->
- Put tests under `test/` next to the module name, using the repo's existing test runner. <!-- default topic:test-location -->
