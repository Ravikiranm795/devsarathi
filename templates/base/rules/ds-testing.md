---
paths: {{testGlobs}}
---
# Testing

- Every new or changed behaviour gets a test; map tests to the spec's acceptance criteria. <!-- strict topic:test-required -->
- Follow the existing test style and location in this repo. <!-- strict topic:test-style -->
- Run the tests with `{{testCommand}}` and report the real result; never claim a pass without running them. <!-- strict topic:test-run -->
- Tests must not depend on network access, wall-clock time or execution order. <!-- default topic:test-isolation -->
