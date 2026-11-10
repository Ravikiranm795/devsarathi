# DevSarathi

*Sarathi* is the charioteer who steers while the warrior fights. DevSarathi steers you and Claude with the right context.
It builds a knowledge graph of your repo (**Drishti**, "vision"), generates a tailored Claude workspace, reviews your work
before you push, turns short requests into accurate prompts, and records local metrics that show whether it helps.

Everything runs on your machine. There is no telemetry. See [Privacy](#privacy).

## Install

Requires **Node 20 or newer** and git.

```bash
npm i -g @ravikiranm795/dev-sarathi
devsarathi --version
```

DevSarathi uses two native libraries (SQLite and tree-sitter). They ship prebuilt binaries for Windows, macOS and Linux
on x64 and arm64, so no compiler is needed. If an install ever tries to compile, use a current Node LTS.

The first `init` downloads a ~90 MB embedding model **once** and caches it in `~/.devsarathi/models`. No repo data is sent.
For an offline machine, copy a populated `models` folder there and set `DEVSARATHI_OFFLINE=1`
(`DEVSARATHI_MODEL_DIR` points to a different folder).

## Quick start

```bash
cd your-repo
devsarathi init          # asks for the developer's name and a name for each agent, then: detects the stack, asks a few questions, shows a preview, builds the graph
                         # add --claude-md to have Claude load the workspace map, persona and core rules every session
devsarathi status        # graph age, baseline commit, pending approvals
```

Inside Claude Code, the generated slash commands are `/ds-review`, `/ds-enhance`, `/ds-impact`, `/ds-test`, `/ds-status` and more.
In VS Code, install the DevSarathi extension (see below) for the sidebar, progress and notifications.

## What `init` creates

| Where | What |
|-------|------|
| `.claude/rules/ds-core.md` | Always loaded. The short, strict rules: spec first, impact lookup before every edit, minimal scope, tests, no secrets |
| `.claude/rules/ds-index.md` | Always loaded. **The workspace map**: who you are, the stack and its commands, the step-by-step workflow, every rule file with when it loads, every subagent and slash command, where state lives, and what never to do |
| `.claude/rules/ds-persona.md` | Always loaded. The persona: identity, operating principles and hand-offs |
| `.claude/rules/ds-*.md` | On-demand rules: architecture, naming and style, testing, and one per detected stack. Learned conventions carry `source`, `confidence` and `evidence` tags |
| `.claude/agents/ds-*.md` | Five **named** agents (the developer is the persona; the others get the names you choose at init, for example Tara the tester, Raksha the security reviewer). Each file has its mission, procedure, a stack-specific checklist, limits and an output format; the optional `enrich` step adds Claude-drafted guidance marked as such |
| `.claude/commands/ds-*.md` | The slash commands |
| `.claude/CLAUDE.md` or your `CLAUDE.md` | **Optional**, with `init --claude-md`: a marked block that imports the map, persona and core rules so Claude loads them every session. It is shown first, backed up, and removed by `uninstall` |

The three always-loaded files cost about 2,500 tokens per session; everything else loads on demand or when invoked. At session start the hook also tells Claude the persona name, where the map is, and that the `ds-*` agents and `/ds-*` commands exist.

Supported stacks: Angular, React, Java, Python, PHP and Node.js (a package.json with JavaScript or TypeScript sources and no Angular or React). Add one by adding `templates/profiles/<stack>/`.
| `.claude/devsarathi/` | Local state: config, graph, metrics, reviews, logs. Kept out of `git status` through `.git/info/exclude` |
| git hooks | `post-merge`, `post-rewrite`, `pre-push`, chained onto any hook you already have |
| `.claude/settings.json` | Only DevSarathi's hook entries, merged after a preview, a backup and your approval |

Every file DevSarathi creates starts with `ds-`. **It never modifies or deletes a file it did not create.** A name clash is skipped and
reported. Files you edit are never overwritten; `migrate` offers a 3-way merge instead.

## Commands

| Command | What it does |
|---------|--------------|
| `init` | Full setup. Re-runnable: it behaves like `migrate` plus `refresh` |
| `status` | Graph age, baseline commit, branch drift, pending rule changes, kill-switch state, version notice |
| `graph build [--full] [--current]` | Build or refresh the graph. Defaults to the baseline branch; `--current` builds the checked-out branch and labels it non-baseline |
| `refresh` | Incremental graph refresh, then rule proposals (low risk auto-applies and is logged; high risk waits for you) |
| `impact <symbol>` or `--file <path>` | Callers, framework couplings, tests and a confidence grade. Run before editing |
| `search "<query>"` | Semantic plus lexical search over the graph |
| `enhance "<request>" [--spec <path> \| --jira <KEY>]` | Ordered prompt from your request and the spec, with a preview. Stops and lists spec problems instead of guessing |
| `review [--range A..B]` | Security, impact on callers, tests and spec. **The same command the pre-push hook runs** |
| `test` | Checks changed functions have tests, runs the stack's test command, maps results to the spec's acceptance criteria |
| `audit` | Checks the generated workspace for contradictions, duplicates, vague rules, missing evidence and broken references. Never edits |
| `rules pending` / `rules approve <id>` / `rules reject <id>` | Decide high-risk rule changes |
| `metrics [--report]` | Local metrics; writes `report.md` and `report.docx` from the same JSON |
| `dashboard` | Local read-only website on 127.0.0.1 with a per-session token |
| `selftest` | Plants known problems in a throw-away repo and confirms they are caught |
| `skills` | Optional: research, verify and install community Claude skills (see [Privacy](#privacy)) |
| `enrich` | Optional: Claude drafts stack-specific guidance for each agent file (stack summary only, previewed first; `--preview` shows the exact text) |
| `migrate [--check]` | Bring generated files up to the installed version |
| `export-baseline` | Write the template layer into `devsarathi-baseline/` for a one-time team PR |
| `disable` / `enable` | **Kill switch**: turns every hook and automatic behavior off or on |
| `uninstall` | Remove DevSarathi files and hooks, restore your old hooks, keep the graph and metrics |
| `remove-graph` / `remove-metrics` | Delete local data (each shows sizes and asks; metrics deletion is irreversible) |

Add `-C <dir>` to run against another repo and `--json` for machine-readable output. The same commands are exposed to Claude as
MCP tools by `devsarathi-mcp`:

```bash
claude mcp add --scope user devsarathi -- devsarathi-mcp
```

## How it behaves

- **Hooks never block.** `pre-push` prints numbered findings and red flags (secrets, `.env` changes) and always exits 0. A crashed review prints
  `Review did not run: <reason>`. A failed or skipped review can never look like a clean one.
- **Hooks fail open and obey the kill switch.** Run `devsarathi disable` and nothing runs automatically.
- **The graph comes from the baseline branch.** It refreshes automatically only when a pull lands on that branch, in the background, so git never waits.
  Your uncommitted and unpushed changes are tracked on top of it (the overlay); the graph is never rebuilt from a feature branch automatically.
- **Impact is graded.** Static graphs miss reflection, DI by string, runtime lookups and dynamic imports, so every impact result carries a confidence
  grade and the reasons for it.
- **Specs belong to product.** DevSarathi reads markdown specs or Jira text (cached read-only) and never drafts or edits one. If a Jira ticket cannot be
  fetched it asks you to paste it; it never continues on partial context.

## VS Code

The extension is a thin layer over the CLI: staged progress notifications (Scanning, Building graph, Generating rules, Generating agents,
Installing hooks, Auditing), failure notifications with a **Rerun** button, a sidebar with status, buttons and pending approvals, an init wizard and the dashboard.
Install it with `devsarathi vscode install`, or `code --install-extension` on the `.vsix` shipped in the package.

## Privacy

- Source code, secrets and repo data never leave your machine. Secret **values** are never stored in the graph, metrics, logs or reports: only file, line and type.
- `.env`, key and credential files are never read. Their path is recorded, and a change to one raises a red flag at push.
- No telemetry. Metrics hold counts, hashes and timings only (no prompt text, no code) and stay in `.claude/devsarathi/metrics/`.
- Three network uses, all optional or one-time and none carrying repo data:
  1. the embedding model download on first `init` (a public model file);
  2. the daily npm version check (package metadata only; turn it off with `versionCheck: false` in `.claude/devsarathi/config.json`);
  3. the opt-in `enrich` step (stack summary only, Claude with **no tools at all**) and the opt-in `skills` step. It shows you the exact payload first (a stack summary: framework names and top-level folder names), asks Claude with web search only
     (no file or shell access), then checks each suggestion against GitHub's public metadata and scans its files before offering anything.

## Upgrade and roll back

```bash
npm i -g @ravikiranm795/dev-sarathi@latest
devsarathi migrate            # shows a diff first; never overwrites your edits
```

To roll back a bad release, pin the previous version and migrate again:

```bash
npm i -g @ravikiranm795/dev-sarathi@<previous-good-version>
devsarathi migrate
```

There is no auto-update; a one-line notice appears at session start when a newer version exists.

## Troubleshooting

| Symptom | Try |
|---------|-----|
| `graph build failed` | The previous graph stays in use. Read the message, then `devsarathi graph build`. In VS Code use **Rerun** |
| Coverage below 80% | Only the template rules are generated until `devsarathi graph build --full` brings coverage up. Check the ignore list and files over 300 KB |
| Hooks missing after `npm install` (Husky) | Husky regenerates its folder. Run `devsarathi init` again |
| `Review did not run` | The reason is printed. Missing graph: `devsarathi graph build`. Hooks calling a moved install: `devsarathi init` |
| Model download blocked | Use `DEVSARATHI_MODEL_DIR` and `DEVSARATHI_OFFLINE=1` with a pre-fetched model |

## Development

```bash
npm install
npm run build
npm test            # builds, then core, dashboard and extension tests, then Drishti's own tests

# Real-repo check with Playwright (Edge): run init on a repo first, then
DS_REAL_REPO=<repo> DEVSARATHI_HOME=<home used for init> npx vitest run packages/dashboard/test/real-repo.test.ts
devsarathi selftest
```

Layout: `brain/` Drishti (plain JS, see `brain/CHANGES.md`), `packages/core` all logic, `packages/cli`, `packages/mcp`, `packages/vscode`,
`packages/dashboard`, `packages/shared`, `templates/` the versioned template layer and stack profiles, `test-fixtures/`.
Specs and decisions: `MASTER.md`, `DECISIONS.md` (authoritative on conflicts), `MAINTAINER.md`, `docs/DEVIATIONS.md`, `docs/OPEN_QUESTIONS.md`.
