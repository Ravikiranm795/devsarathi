# selftest fixture

A small Python repo used by `devsarathi selftest`. It is clean on its own: the planted problems (a fake AWS-style key,
a modified `.env`, a signature change that skips four callers, a new function without a test, a rule contradiction) are
applied by `packages/core/src/selftest/run.ts` on a throw-away copy, never here.
