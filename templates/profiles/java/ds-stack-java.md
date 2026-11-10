---
paths: {{stackGlobs}}
---
# Java rules

- Use constructor injection with `final` fields; do not use field `@Autowired`. <!-- strict topic:di -->
- Controllers stay thin: validate input, call a service, map the result. Business logic belongs in services. <!-- strict topic:layering -->
- Use parameterized queries only; never build SQL by string concatenation. <!-- strict topic:sql -->
- Return DTOs from the API layer, not JPA entities. <!-- default topic:dto -->
- Handle errors through the shared exception handler; do not swallow exceptions. <!-- default topic:errors -->
- Write JUnit tests under `src/test/java` mirroring the package of the class under test. <!-- default topic:test-location -->
