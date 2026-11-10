# Changelog

Template changes are marked **[template]**: they affect `devsarathi migrate`. Versions follow semantic versioning.

## 0.1.0 (unreleased)

First build of DevSarathi, produced from MASTER.md and DECISIONS.md.

### Added
- `init` flow: stack detection (Angular, React, Java, Python, PHP profiles), baseline branch, persona, token-budget and file preview, graph build,
  workspace generation, hooks, audit, registry, optional skills step.
- Drishti graph (`brain/`): baseline-branch model with temporary worktrees, coverage and threshold, overlay for uncommitted and unpushed changes,
  framework facts (Angular DI, templates and routes; Spring; Django, FastAPI, Flask; Laravel, Symfony), impact with confidence and reasons,
  secret redaction and secret-file handling, offline embedding mode. See `brain/CHANGES.md`.
- **[template]** `ds-core`, `ds-architecture`, `ds-naming-style`, `ds-testing` and per-stack rules; five agents; fifteen slash commands.
- Hybrid rules with precedence developer > template-strict > graph > template-default, rule metadata, risk-classified drift handling and a changelog.
- `review` (security, impact, tests, peer checks, spec), `test`, `audit`, `enhance`, `impact`, `search`.
- Hooks: `post-merge`, `post-rewrite`, `pre-push`, Claude Code `SessionStart`, `UserPromptSubmit`, `Stop`. Fail-open, kill switch, chained onto existing hooks.
- Metrics (JSON source of truth, markdown and Word reports), local dashboard, VS Code extension.
- `migrate` with 3-way merge proposals, `uninstall`, `remove-graph`, `remove-metrics`, `export-baseline`, `selftest`, `version-check`, MCP server.

### Found by running on a real repo (D:/AI-brain, a Node.js CLI)
- Drishti failed to parse any source file over 32 KB (tree-sitter's default buffer), lowering coverage; fixed.
- `review` flooded the output on a large branch and reported functions as untested although tests existed elsewhere in the tree; it now reads every test file, lists at most 20 untested functions and summarizes the rest. The pre-push view shows at most 25 findings (red flags are never hidden).
- DevSarathi's own generated files were being reviewed, and started the tester at task end; both now ignore them.
- Added a **Node.js** stack profile.
- Added the always-loaded workspace map (`ds-index.md`) and persona (`ds-persona.md`), the optional `CLAUDE.md` import block, and richer session-start context.

### Agents
- `init` asks for a name for each agent (`--agent-names tester=Tara,...`); every agent file, the persona's team table and the workspace map use those names, and hand-offs only mention agents that exist.
- Agent files rewritten with a mission, procedure, stack checklist, limits and output format; per-stack checklists for Angular, React, Java, Python, PHP and Node.js.
- New `enrich` command and `init --enrich`: Claude drafts stack-specific guidance for each agent file. It sees the stack summary only and runs with no tools; the reply is clamped and risky text and links are dropped. Verified live on a real repo.
- Fixed the Claude CLI call on Windows (`--tools=`); one shared runner now serves both the skills and the enrich steps.
- VS Code extension: wizard asks the agent names, the enrich question and the CLAUDE.md block; verified in a real VS Code 1.145 extension host; packaged with the official `vsce` (icon, README, changelog, workspace-trust declaration) and ready for the Marketplace.

### Known limits
- The optional skills research call (`claude -p` with web tools) was not run live; the enrich call was.
- Real-repo proof on Angular, Java and Python repos is pending; fixtures only so far.
- Large-repo (2 to 3 GB) behavior has not been measured.
