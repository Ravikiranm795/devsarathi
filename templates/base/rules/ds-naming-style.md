---
paths: {{sourceGlobs}}
---
# Naming and style

- Match the naming of neighbouring files and symbols; do not introduce a new naming scheme. <!-- strict topic:naming -->
- Run the repo's formatter and linter before finishing ({{lintCommand}}). <!-- strict topic:lint -->
- Remove dead code and unused imports you create; do not leave commented-out code. <!-- default topic:dead-code -->
- Prefer small, pure functions; avoid hidden side effects. <!-- default topic:purity -->
