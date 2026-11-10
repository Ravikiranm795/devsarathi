---
paths: {{sourceGlobs}}
---
# Architecture

- Respect module boundaries: do not import across feature areas unless the dependency already exists. <!-- strict topic:module-boundaries -->
- Put new code where similar code already lives; do not create a new top-level folder without asking. <!-- strict topic:placement -->
- Keep business logic out of controllers, components and route handlers; put it in a service or domain layer. <!-- default topic:layering -->
- Prefer extending an existing abstraction over adding a parallel one. <!-- default topic:reuse -->
