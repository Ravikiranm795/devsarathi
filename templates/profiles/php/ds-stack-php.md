---
paths: {{stackGlobs}}
---
# Php rules

- Use dependency injection through the constructor; do not call `new` on services inside methods. <!-- strict topic:di -->
- Use query bindings or the ORM; never concatenate user input into SQL. <!-- strict topic:sql -->
- Validate requests in form requests or validators, not in controllers. <!-- default topic:validation -->
- Keep controllers thin; put logic in services or actions. <!-- default topic:layering -->
- Escape output in views; do not echo raw user input. <!-- strict topic:xss -->
- Write PHPUnit tests under `tests/` mirroring the class namespace. <!-- default topic:test-location -->
