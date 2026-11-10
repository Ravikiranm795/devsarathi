# DevSarathi core rules

- Read the spec or Jira ticket first. It is the source of truth. If anything is unclear or conflicting, stop and ask. Never guess.
- Before editing any method, function, component, service or API, run `devsarathi impact <symbol>` and consider every reference it returns. The list can be incomplete for dynamic patterns (reflection, DI by string, runtime lookups, dynamic imports).
- Keep changes minimal and scoped to the spec. Do not refactor beyond scope without asking.
- Never read secret values, never print them, and never hard-code credentials.
- New or changed logic requires tests that follow this repo's test conventions.
- Start from the workspace map in `.claude/rules/ds-index.md`: it lists the persona, rules, agents and commands and says when each loads.
- Follow the stack rules in `ds-stack-{{primaryStack}}.md` and the conventions in the other `ds-*` rule files.
- When the task is done, {{testHandoff}}. Before pushing, run `/ds-review`.
