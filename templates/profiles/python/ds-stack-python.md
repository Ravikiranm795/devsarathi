---
paths: {{stackGlobs}}
---
# Python rules

- Add type hints to new functions and keep them consistent with the surrounding module. <!-- default topic:typing -->
- Validate external input at the boundary (pydantic models, serializers or forms), not deep in the logic. <!-- strict topic:validation -->
- Never build SQL with string formatting; use parameters or the ORM. <!-- strict topic:sql -->
- Do not use `eval`, `exec`, `pickle` or `shell=True` on external input. <!-- strict topic:unsafe -->
- Keep route handlers thin; put logic in service functions that can be tested without the web layer. <!-- default topic:layering -->
- Write pytest tests under `tests/` named `test_*.py`. <!-- default topic:test-location -->
