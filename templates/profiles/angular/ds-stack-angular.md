---
paths: {{stackGlobs}}
---
# Angular rules

- Components are presentational; fetching and business logic belong in services. <!-- default topic:layering -->
- Use dependency injection through the constructor or `inject()`; never instantiate a service with `new`. <!-- strict topic:di -->
- Unsubscribe from observables (`async` pipe, `takeUntilDestroyed`, or `take(1)`); do not leak subscriptions. <!-- strict topic:rxjs -->
- Do not bypass Angular sanitization (`bypassSecurityTrust*`, `innerHTML`) without a spec reason. <!-- strict topic:xss -->
- Keep one component, service, directive or pipe per file, named `name.kind.ts`. <!-- default topic:naming -->
- Prefer typed forms and strict templates; no `any` in new code. <!-- default topic:typing -->
- Place unit tests next to the file as `*.spec.ts`. <!-- default topic:test-location -->
