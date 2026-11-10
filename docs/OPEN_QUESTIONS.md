# Open questions

Unspecified items. Each has a working default so the build is not blocked.

| ID | Question | Working default |
|----|----------|-----------------|
| Q-01 | "Slash commands via MCP": Claude Code slash commands are files in `.claude/commands/`. MCP prompts surface as `/mcp__<server>__<prompt>`. Which is the primary mechanism? | Generate `.claude/commands/ds-*.md` (primary). The MCP server also exposes the same commands as tools. |
| Q-02 | How is "turns per task" measured (§16)? | A task opens on the first user prompt after the previous agent-stop (or after 30 min idle) and closes on the next agent-stop. A turn is one user prompt inside the window. Counts only; no text. |
| Q-03 | `.claude` is git-ignored in company repos, yet a team baseline is committed once (§8.3). | `export-baseline` writes to `devsarathi-baseline/` (outside `.claude`) so the PR is not blocked by the ignore rule. |
| Q-04 | Exact Claude Code hook schema, agent front-matter and tool names. | Follow current docs at implementation time; log gaps in DEVIATIONS.md. |
| Q-05 | License, npm scope ownership, company courtesy heads-up (§27). | Owner actions before Gate C. `LICENSE` is a placeholder. |
| Q-06 | Real-repo paths for the Angular, Java and Python proof runs. | Fixtures only until the owner supplies them. |
