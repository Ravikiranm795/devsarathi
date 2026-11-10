# DevSarathi — Final Decision Log

> This file is **authoritative**. If MASTER.md or any other document conflicts with it, this file wins.
> Superseded decisions are listed so agents do not reintroduce them.

## Final Decisions

| ID | Area | Final decision |
|----|------|----------------|
| D-01 | Name | Product **DevSarathi**, brain **Drishti**, npm package **`@ravikiranm/dev-sarathi`**, CLI command `devsarathi`. |
| D-02 | Scope | VS Code first. IntelliJ is phase 2 over a shared core. Version 1 is proven on Angular, Java and Python. Detection is generic and extensible. |
| D-03 | Architecture | One core. The CLI, MCP, VS Code extension and hooks are thin adapters calling the same commands. |
| D-04 | Rules | Hybrid layering: strict template layer, graph-derived layer on top, and developer edits always win. |
| D-05 | Rule drift | Low-risk changes auto-apply and are logged. High-risk changes need developer approval. Every rule carries source and confidence tags, with a cap and pruning. |
| D-06 | Team baseline | Optional. Committed once through a PR. Everything afterwards is local and never updated by pulls. |
| D-07 | Existing `.claude` | DevSarathi never modifies or deletes files it didn't create. All of its files are `ds-` prefixed. A clash means skip and report. The only exception is the settings hook-entry merge, which requires a preview, a backup and approval. |
| D-08 | Graph source | The graph is built from the **baseline branch** only. The automatic build triggers **only** on a pull of the baseline branch. Manual builds are allowed on any branch and are labeled with branch and commit. |
| D-09 | Overlay | A read-only tracker of uncommitted and unpushed changes on top of the baseline. It is not a graph rebuild. |
| D-10 | Graph failure | Below the coverage threshold, DevSarathi generates the template layer only, with a warning and a one-command rebuild. |
| D-11 | Hooks | Hooks **never block** anything. They warn, list findings and raise red flags. They fail open. No bypass flag is needed. |
| D-12 | Review | `/devsarathi review` and the pre-push hook run **the same** review command. There is no separate "lighter" pass. |
| D-13 | Failures | Agent failures appear in VS Code notifications with the error and a Rerun button. A failure never looks like a pass. |
| D-14 | Performance | No time cap. Everything heavy runs in the background with a staged progress notification. Git never waits. |
| D-15 | Ignore list | Dependency and build output is ignored by default. The list is editable. |
| D-16 | Privacy | Everything is local. No telemetry. Metrics never leave the machine. |
| D-17 | Exception | The **only** model call is the opt-in skills step, which sends a stack summary only, with a payload preview. |
| D-18 | Metrics | Ship in version 1. JSON is the source of truth, with Word (docx) and markdown reports generated from it. The VS Code dashboard plus a local website reads them. |
| D-19 | Prompt | Fixed order. A target of about 400 characters with an adaptive ceiling. References instead of prose. Preview on by default. Spec and core rules are always included. |
| D-20 | Invocation | Explicit invocation through a slash command or button. After invocation, the flow runs automatically. |
| D-21 | Specs | Written by PMs and directors. DevSarathi only consumes markdown specs or Jira tickets (MCP or paste) and **never drafts specs**. |
| D-22 | Spec issues | Ambiguities and conflicts are flagged before work starts. The spec hash is recorded, and review warns if the spec changed. |
| D-23 | Jira failure | DevSarathi says so and asks for a paste. It never proceeds on partial context. |
| D-24 | Persona | One developer persona per repo, titled from the detected stacks. With more than two stacks, the developer confirms the title. |
| D-25 | Init | Interactive in the terminal or through the VS Code extension. The extension is mandatory for the team. |
| D-26 | Skills | The last step and optional. Claude researches market skills, which are verified locally. Unverified skills are listed with a warning and never pre-ticked. Only ticked skills are installed, at pinned versions. |
| D-27 | Self-test | In version 1. Planted problems confirm that the agents actually catch issues. |
| D-28 | Install and updates | npm with semantic versioning. Updates are manual, with a one-line notice of new versions. `migrate` respects edits. Rollback is done by pinning the previous version. |
| D-29 | Uninstall | Removes DevSarathi files and hooks, restores previous hooks, and keeps the graph and metrics. `remove-graph` and `remove-metrics` are separate and confirmed. |
| D-30 | Platform | Node scripts only, Node 20+ minimum, cross-platform paths. |
| D-31 | Kill switch | `disable` and `enable` turn off or on all hooks and automatic behavior. |
| D-32 | Maintenance | The owner is the sole maintainer with git access. Teammates use npm only. |
| D-33 | Brain | Drishti is the owner's own project. Its source goes in `brain/`. Multi-language support is a build task. |

## Superseded Decisions (Do Not Implement)

| Was | Replaced by |
|-----|-------------|
| Hard block on clear-cut secrets at push | D-11: warn only, never block |
| Bypass environment flag for blocked pushes | Not needed (D-11) |
| Pull hook with a ~10 s time cap | D-14: background, no cap |
| Pre-push "lighter pass" separate from slash review | D-12: same review command |
| Graph refresh on feature-branch pulls | D-08: baseline branch only |
| Tool drafts specs from Jira and impact | D-21: never drafts specs |
| Spec template provided by the tool | D-21: specs come from PMs |
| "Nothing is ever sent to an LLM", without exception | D-17: the opt-in skills step is the sole exception |
| Secrets files fully excluded from the graph | Existence and path are recorded. Values are never stored (MASTER §7.2). |
| Opt-in remote usage reporting | D-16: strictly local |
| Skills only from a curated catalog | D-26: market research, plus verification and labels |
| Names Sherpa, Cairn, Sandarbha Sarathi and others | D-01 |
