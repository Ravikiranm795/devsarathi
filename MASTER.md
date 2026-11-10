# DevSarathi — Master Build Specification

> **Package:** `@ravikiranm/dev-sarathi` · **CLI command:** `devsarathi` · **Knowledge graph engine (the brain):** Drishti
> **Owner and sole maintainer:** Ravikiran
> **Audience for this file:** the orchestrator, developer, QA and metrics agents that will build DevSarathi end to end.
> **Companion files:** `DECISIONS.md` (final decision log, authoritative on conflicts) · `MAINTAINER.md` (release and extension guide)

---

## 0. How the Agents Should Use This Document

1. Read this file fully, then `DECISIONS.md`. If anything here seems to conflict with `DECISIONS.md`, **`DECISIONS.md` wins**. Raise the conflict to the human owner.
2. The orchestrator owns the plan and shared state. All agent-to-agent communication goes through the orchestrator.
3. Build in the **stages in §24**. Each stage must pass its QA checks before the next starts.
4. Stop at the **three approval gates in §24.2** and wait for the human owner.
5. Before implementing anything that depends on Claude Code conventions, verify the current conventions against the official Claude Code documentation. That includes file locations for agents, commands, skills and hooks, the `settings.json` hook schema, and the MCP server registration format. If the docs differ from this spec, follow the docs and record the deviation in `docs/DEVIATIONS.md`.
6. Never invent requirements. If something is unspecified and not covered by a "default" in this file, list it in `docs/OPEN_QUESTIONS.md` and continue with other work.
7. Keep every file the tool *generates* small, deterministic and tagged (see §9.3).

---

## 1. Product Summary

**Problem.** Developers use AI like a text box. They give incomplete prompts and no project context, so output is inaccurate. The company is moving to spec-driven development, and developers still struggle to give Claude the full context of a task.

**Solution.** DevSarathi is an npm-installed tool with three front doors over one shared core:

- a **CLI** (`devsarathi …`)
- an **MCP server** exposing the same commands as slash commands inside Claude
- a **VS Code extension** (thin UI, notifications, buttons, dashboard)

When a developer runs `init` on any repo, DevSarathi:

1. detects the language and framework stack,
2. triggers Drishti to build a knowledge graph of the whole repo,
3. generates a tailored Claude workspace: rules, agents, commands, hooks and settings,
4. installs git hooks and Claude Code hooks that keep the workspace current and review code before push,
5. optionally recommends and installs Claude skills,
6. records local metrics that prove the tool's value.

It also contains a **prompt enhancer**. It takes the developer's request plus the spec or Jira ticket, adds graph-derived context (files, symbols, impact), and produces a short, ordered, accurate prompt.

**Name meaning.** *Sarathi* is the charioteer who steers while the warrior fights. DevSarathi steers the developer and Claude with the right context. *Drishti* means vision: the graph that sees the whole codebase.

---

## 2. Goals and Non-Goals

### 2.1 Goals (Version 1)

- Works on **any single-purpose repo**: Angular, React, Java, Python, PHP, with an extensible profile system.
- Version 1 must be **proven** on Angular, Java and Python repos.
- **VS Code first.** IntelliJ follows in phase 2, using the same shared core.
- Makes Drishti impact analysis **mandatory before any code edit**.
- Treats the spec or Jira ticket as the **source of truth**.
- Runs fully **local**. The only exception is the optional skills step (§19).
- Ships **metrics in version 1**, because proving value is the purpose of version 1.

### 2.2 Non-Goals

- **Writing or editing specs.** Specs are owned by product managers and directors. DevSarathi only *consumes* them.
- **Blocking git operations.** Hooks warn. They never block.
- **Sending usage data anywhere.** There is no telemetry, no remote metrics and no company endpoint.
- **Replacing the developer.** The developer is always the final approver.
- **Mixed-language monorepo special handling.** The company uses dedicated repos per stack. A light safeguard exists (§6).

---

## 3. Invariants (Must Never Be Violated)

| # | Invariant |
|---|-----------|
| I-1 | No source code, secrets or repo data leave the machine. The single exception is the opt-in skills step, which sends only a stack summary (§19). |
| I-2 | Hooks **never block** pull, push or commit. They warn, list findings and raise red flags. |
| I-3 | Hooks **fail open**. A tool crash produces a visible notification, never a blocked git operation. |
| I-4 | A failed or skipped review must **never look like a clean review**. |
| I-5 | DevSarathi never modifies or deletes files it did not create. The one exception is merging hook entries into an existing Claude settings file, which requires a preview, a backup and explicit approval (§12.3). |
| I-6 | The automatic graph build runs **only** on a pull of the configured baseline branch. Feature branches never trigger automatic builds. Manual builds are allowed from any branch. |
| I-7 | Hooks are generated and run by **deterministic local logic**. No LLM decides what a hook executes. |
| I-8 | Secret **values** are never stored in the graph, metrics, logs or reports. Only the file, line and type are recorded. |
| I-9 | The prompt enhancer never removes the spec or core rules from a prompt. |
| I-10 | Developer edits to generated files always win over regeneration (§9.4). |

---

## 4. Architecture

### 4.1 Components

```
                 ┌──────────────────────────────────────────┐
                 │            @ravikiranm/dev-sarathi        │
                 │                                          │
  Terminal ───▶  │  CLI (devsarathi)  ─┐                     │
  Claude    ───▶ │  MCP server        ─┼──▶  CORE (TypeScript)│ ──▶ Drishti (brain/)
  VS Code   ───▶ │  (extension calls  ─┘     commands,        │      knowledge graph
                 │   CLI/core)               generators,      │
  git hooks ───▶ │  hook runners (Node)      hooks, metrics   │ ──▶ .claude/ + state
                 └──────────────────────────────────────────┘
                                   │
                    Local dashboard website (localhost)
                    reads ~/.devsarathi/registry.json + each repo's metrics JSON
```

**Rule.** All business logic lives in **core**. The CLI, MCP server, VS Code extension and hooks are thin adapters that call core commands. One command implementation serves every entry point. For example, the pre-push hook calls the same `review` command as `/devsarathi review`.

### 4.2 Technology Defaults

These defaults may be changed only with a recorded reason.

- **Language:** TypeScript, compiled to CommonJS or ESM per the Node version. Minimum **Node 20 LTS**, which `init` checks up front with a clear message.
- **CLI:** `commander` (or equivalent). **MCP:** the official MCP TypeScript SDK.
- **Word reports:** the `docx` npm library. **Markdown reports:** generated from the same JSON.
- **Git access:** `child_process` calling `git`, with no shell string concatenation (arguments as arrays).
- **Cross-platform:** every path goes through `path`/`path.posix` correctly, there are no shell scripts, line-endings are normalized, and Windows is tested at least once per release.
- **VS Code extension:** TypeScript and the VS Code API. The dashboard is a webview that reuses the dashboard website bundle.

### 4.3 Source Repository Layout (DevSarathi's Own Repo)

```
dev-sarathi/
├── brain/                  # Drishti source (Ravikiran's existing brain MCP, placed here by the owner)
├── packages/
│   ├── core/               # all logic: detect, graph, generate, enhance, review, metrics, hooks, skills
│   ├── cli/                # devsarathi binary
│   ├── mcp/                # MCP server, slash commands
│   ├── vscode/             # extension (thin)
│   ├── dashboard/          # local website (static bundle + tiny local server)
│   └── shared/             # types, schemas, constants (shared with future IntelliJ plugin)
├── templates/              # versioned template layer (rules, agents, commands, hook stubs)
│   └── profiles/           # stack profiles: angular, react, java, python, php, …
├── overlays/               # company-specific overlay (kept OUT of the public core package)
├── test-fixtures/          # small planted-problem repos for self-test and CI
├── docs/                   # DEVIATIONS.md, OPEN_QUESTIONS.md, architecture notes
├── README.md
├── MAINTAINER.md
└── CHANGELOG.md
```

**Phase 2.** `packages/intellij/` will reuse `packages/core` through the CLI/MCP and `packages/shared`.

---

## 5. The `init` Flow

`init` is interactive in the terminal, or driven by the VS Code extension. The extension is mandatory for the team. Heavy work runs in the **background** with staged progress (§17).

1. **Preflight checks:** the Node version, whether this is a git repo, write access, and whether DevSarathi is already initialized. If it is, `init` offers to refresh or migrate.
2. **Detect the stack** (§6) and show the result. The developer confirms.
3. **Ask the baseline branch name.** Suggest `development`, `develop`, `dev` or `main` based on what exists.
4. **Ask a minimal set of questions:**
   - the developer persona's name,
   - confirmation of the persona title (§6),
   - yes or no for each optional agent (tester, security, peer review, auditor; all default yes),
   - the location of specs, if any (a path or glob; optional).
5. **Show the token budget preview.** For each piece to be generated, show its estimated size and whether it is always loaded or loaded on demand.
6. **Show a full preview of every file to be created**, marking which are new, which are skipped due to name clashes, and which settings merge needs approval.
7. **Build the graph in the background** (§7) on the baseline branch. If the developer is on another branch, the build uses a temporary `git worktree` of the baseline, and their working branch is **never switched**.
8. **Generate the workspace** (§8 to §13) using the template layer plus graph-derived findings.
9. **Install hooks** (§12), preserving existing hooks.
10. **Run the auditor agent** (§10.5). It produces a pass or fix report.
11. **Register the repo** in `~/.devsarathi/registry.json` for the dashboard.
12. **Optional skills step** (§19). It is offered last and requires opt-in.
13. **Summary:** what was created, the graph coverage, the auditor result, and the next commands to try.

`init` is **re-runnable**. A re-run behaves like `migrate` plus `refresh`: it shows a diff and respects local edits.

---

## 6. Stack Detection and Persona

### 6.1 Detection

Detection is deterministic and based on manifest files plus file-extension counts:

| Signal | Stack |
|--------|-------|
| `angular.json`, `@angular/core` in package.json | Angular |
| `react` / `react-dom` in package.json (and no Angular) | React |
| `pom.xml`, `build.gradle(.kts)` | Java (Maven/Gradle; detect Spring Boot) |
| `pyproject.toml`, `requirements.txt`, `setup.py` | Python (detect Django/FastAPI/Flask) |
| `composer.json`, `*.php` | PHP (detect Laravel/Symfony) |

Detection also records the test framework, linter or formatter, build tool, package manager and state-management library where detectable.

Profiles are **pluggable**. Adding a stack means adding `templates/profiles/<stack>/` (§MAINTAINER).

### 6.2 Persona Title

- **One stack:** "<Stack> Developer", for example "Angular Developer".
- **Frontend plus backend** (for example, Angular and Java): "Full Stack Developer (Angular + Java)".
- **Two frontend stacks** (for example, Angular and React): "Front-end Developer (Angular + React)".
- **More than two stacks:** ask the developer to confirm or edit the title. Never guess.

The persona's name comes from the developer.

---

## 7. Drishti Integration and Graph Lifecycle

### 7.1 Drishti

- The Drishti source lives in `brain/`. The owner will place the existing brain MCP code there.
- **Required task:** extend Drishti to support all version 1 stacks (Angular/TS, Java, Python) and keep it extensible for React and PHP. Record the changes in `brain/CHANGES.md`.
- DevSarathi calls Drishti through a stable internal interface, `core/graph/DrishtiClient`, so the brain can evolve independently.

### 7.2 What Gets Read

- The initial build reads **every file** in the repo locally, minus the ignore list.
- **Default ignore list** (editable in config): `node_modules`, `dist`, `build`, `target`, `out`, `.next`, `.angular`, `coverage`, `vendor`, `__pycache__`, `.venv`, `venv`, `.gradle`, `.idea`, `.git`, minified files, lock files (record their existence only), and binaries.
- **Env and secret files** (`.env*`, `*.pem`, `*.key`, credential configs) are scanned by the security scanner. Only their **existence and path** enter the graph. Their values never do (I-8).

### 7.3 Baseline Branch Model

- The graph represents the **baseline branch** (configured at init).
- **Automatic rebuild:** only when a pull lands on the baseline branch (the `post-merge` and `post-rewrite` hooks check the current branch). The rebuild is incremental from the changed files and runs in the background.
- **Manual build:** allowed from any branch through the CLI, MCP or extension. The build record stores the **branch, commit and timestamp**. A non-baseline build is labeled as such and is never presented as the baseline.
- **Overlay:** a read-only tracker of the developer's uncommitted and unpushed changes, including deletions, relative to the baseline. Impact queries combine the graph and the overlay. The overlay is never a graph rebuild (I-6).
- **Staleness:** session start shows the graph's age, the branch and commit it was built from, and a "your branch is N commits behind baseline" note when relevant.

### 7.4 Coverage and Failure

- Each build records **coverage**: files parsed out of eligible files, and symbols resolved.
- **Below the threshold** (default 80%, configurable): skip graph-derived rules, generate the template layer only, show a clear warning, and offer `devsarathi graph build --full`.
- A build failure triggers a notification with the error and a **Rerun** button, and the previous graph stays in use.

### 7.5 Accuracy Limits

Static graphs miss dynamic references, such as Java reflection, DI by string, runtime lookups, and dynamic imports.

- Every impact result carries a **confidence note** (high, medium or low) plus the reasons.
- Review agents are told that the impact list may be incomplete. They must reason about dynamic patterns when they see them.

### 7.6 Mandatory Impact Analysis

The core rules (§9.2) require a Drishti impact lookup **before editing any method, function, component, service or API**. The peer-review agent verifies that the impact list was consulted and that every listed reference was considered.

---

## 8. Generated Workspace Layout (In the Target Repo)

The `.claude` folder is git-ignored in the company's repos. A team baseline may be committed once through a normal PR, as a one-time starting point (§8.3).

> Verify the exact Claude Code locations against the current docs (§0.5). Everything DevSarathi creates uses the **`ds-` prefix** so it never collides with existing files.

```
.claude/
├── agents/
│   ├── ds-developer.md        # persona, e.g. "Asha — Full Stack Developer (Angular + Java)"
│   ├── ds-tester.md
│   ├── ds-security.md
│   ├── ds-peer-review.md
│   └── ds-auditor.md
├── rules/
│   ├── ds-core.md             # ALWAYS loaded, short, strict
│   ├── ds-architecture.md     # on demand
│   ├── ds-naming-style.md     # on demand
│   ├── ds-testing.md          # on demand
│   └── ds-stack-<stack>.md    # one per detected stack, on demand
├── commands/
│   └── ds-*.md                # slash command definitions (see §11)
├── skills/                    # only skills the developer chose to install (§19)
└── devsarathi/                # DevSarathi's own state (namespaced)
    ├── config.json            # baseline branch, ignore list, agent names, specs path, thresholds, tool version, kill switch
    ├── graph/                 # Drishti graph + build-record.json (branch, commit, time, coverage)
    ├── overlay/               # uncommitted/unpushed change tracking
    ├── hooks/                 # Node hook runners (called by git + Claude Code hooks)
    ├── changelog.md           # every automatic rule change, with reason + source
    ├── metrics/
    │   ├── metrics.json       # source of truth
    │   ├── report.md          # generated
    │   └── report.docx        # generated
    ├── reviews/               # review results per run (JSON + md)
    ├── locks/                 # concurrency lock files
    └── logs/
```

### 8.1 Collision Policy

- DevSarathi **never** overwrites or deletes files it didn't create (I-5).
- On a name clash, DevSarathi **skips** the file and reports it in the init summary.
- Ownership is tracked in `config.json → managedFiles[]` with a content hash, so DevSarathi always knows exactly which files are its own.

### 8.2 Version Stamping

Every generated file carries a header comment or front-matter field holding the `devsarathi-version`, the template version, the generation time and the source. `migrate` uses these stamps.

### 8.3 Team Baseline (Optional)

`devsarathi export-baseline` writes the current template-layer rules and agents (no state, no graph) into a folder the team can commit through a PR **once**. After that, everything is local. Pulls never update `.claude` content other than through DevSarathi's own regeneration.

---

## 9. Rules

### 9.1 Hybrid Layering

1. **Template layer:** fixed, versioned, strict, non-negotiable guidelines. It ships with the package, and the company overlay is added on top.
2. **Graph-derived layer:** conventions learned from the repo, such as folder structure, naming, test style, state management, API patterns and module boundaries.
3. **Developer layer:** the developer's own edits. These always win (I-10).

Where they conflict, the precedence is **Developer > Template-strict > Graph-derived > Template-default**.

### 9.2 Core Rules (`ds-core.md`, Always Loaded, Kept Short)

The content is a minimum and may be phrased tighter:

- Read the spec or Jira ticket first. It is the source of truth. If something is unclear or conflicting, **stop and ask**. Never guess.
- Run a Drishti impact lookup before editing any method, function, component, service or API. Consider every reference it returns.
- Keep changes minimal and scoped to the spec. Do not refactor beyond scope without asking.
- Never read secret values, never print them, and never hard-code credentials.
- New or changed logic requires tests that follow the repo's test conventions.
- Follow the stack rules in `ds-stack-<stack>.md` and the conventions in the on-demand rule files.
- When done, hand off to the tester. Before push, run `/devsarathi review`.

### 9.3 Rule Metadata

Every rule line or block carries:

- `source:` either `template@<ver>` or `graph@<build-commit>`, or `developer`,
- `confidence:` high, medium or low (graph-derived rules only),
- `evidence:` file paths or symbols that justify a graph-derived rule (graph-derived rules only).

### 9.4 Change Management After Pulls

When a baseline pull triggers a refresh, DevSarathi may propose rule changes. Each change is classified by risk:

| Risk | Examples | Behavior |
|------|----------|----------|
| Low | new folder added to the structure notes, a new module listed, an evidence path updated | **Auto-apply**, logged in `changelog.md` |
| High | editing a strict rule, changing agent behavior, removing a rule, a change touching many files | **Wait for developer approval** (VS Code notification + `devsarathi rules pending`) |

**Pruning.** A rule whose evidence no longer exists in the graph is proposed for removal, which is a high-risk change. Each on-demand rule file is soft-capped at around 40 rules to prevent bloat. Above the cap, DevSarathi consolidates and asks for approval.

**Developer edits.** If a managed file's hash differs from the recorded hash, the developer has edited it. DevSarathi then **never** overwrites it and offers a 3-way diff instead.

---

## 10. Agents

Each agent is a markdown file with a narrow role, a **tool allowlist**, and a **fixed output format** so results are consistent and machine-readable.

### 10.1 `ds-developer` (Persona)

- **Name and title:** from init (§6).
- **Knows:** the stack rules, conventions, and that the spec is the source of truth.
- **Must:** run the impact lookup before edits, keep changes scoped, and hand off to the tester when the task is complete.
- **Tools:** file read and write, the Drishti MCP, and the test runner commands for the stack.

### 10.2 `ds-tester`

- **Triggered** after task completion, through the post-task hook or `/devsarathi test`.
- **Checks:** whether tests exist for the changed logic, runs the stack's test command, and maps the results to the spec's acceptance criteria.
- **Output:** JSON with `status`, a per-criterion pass or fail, the missing tests, and the failures.

### 10.3 `ds-security`

- **Scans** the diff (staged plus unpushed) for hard-coded credentials, API-key patterns, private keys, `.env` changes, unsafe deserialization, injection patterns, insecure configs, and dependency changes.
- **Output:** findings with severity (critical, high, medium or low), the file and line, and a fix suggestion. Secret values are always masked.

### 10.4 `ds-peer-review`

- **Reviews** the diff against the spec, the rules and the impact list.
- **Checks:** whether every impacted reference was considered, purity and simplification opportunities, naming and style, dead code, duplicated logic, and the risk of side effects.
- **Output:** numbered comments with severity and a suggested rewrite where useful.

### 10.5 `ds-auditor`

- **Runs last** during init and after `migrate`.
- **Audits** the generated workspace for contradictions between rules, duplicates, vague rules, rules whose evidence paths or symbols do not exist in the graph (hard evidence check), oversized always-loaded content, and broken references between agents and commands.
- **Output:** a pass or fix list. The auditor **never edits silently**.

### 10.6 Failure Handling for All Agents

- Every agent run produces a result file in `devsarathi/reviews/` with a `status` of `completed`, `failed` or `timeout`.
- **Failed or timed out:** a VS Code notification says "<Agent> did not run: <error>", with a **Rerun** button. A run in this state is never counted as a pass (I-4).

---

## 11. Commands (One Implementation, Three Front Doors)

Each command exists as `devsarathi <cmd>` (CLI), `/devsarathi <cmd>` or a `ds-` slash command (MCP/Claude), and a button or palette entry in the VS Code extension. The exact slash syntax follows the current Claude Code conventions.

| Command | Purpose |
|---------|---------|
| `init` | Full setup (§5) |
| `status` | Graph age, baseline commit, branch drift, pending rule changes, kill-switch state, version notice |
| `graph build [--full]` | Manual graph build (any branch; labeled) |
| `refresh` | Incremental refresh plus rule proposals |
| `enhance "<request>" [--spec <path> \| --jira <KEY>]` | Prompt enhancer (§13) |
| `review` | Full security plus peer review plus impact check on the current diff (the same command the pre-push hook calls) |
| `test` | Run the tester agent |
| `rules pending` / `rules approve <id>` / `rules reject <id>` | Approve or reject high-risk rule changes |
| `metrics [--report]` | Show metrics and regenerate the md and docx reports |
| `dashboard` | Open the local dashboard website |
| `selftest` | Run the planted-problem self-test (§23) |
| `skills` | The optional skills step (§19) |
| `migrate` | Bring the generated files up to the installed version (diff; respects edits) |
| `export-baseline` | Write the team baseline folder (§8.3) |
| `disable` / `enable` | **Kill switch.** Turns all hooks and automatic behavior off or on |
| `remove-graph` | Delete local graph data (shows sizes, asks yes or no) |
| `remove-metrics` | Delete local metrics (shows sizes, warns that this is irreversible, asks yes or no) |
| `uninstall` | Remove DevSarathi files and hooks (§22) |

---

## 12. Hooks

All hook logic is written as **Node scripts** in `devsarathi/hooks/`. The git and Claude Code hook entries only call those scripts. Every hook checks the kill switch first.

### 12.1 Git Hooks

| Hook | Behavior |
|------|----------|
| `post-merge` and `post-rewrite` (pull) | If the current branch equals the baseline, it queues a **background incremental graph refresh** and then rule proposals (§9.4). It returns immediately, so git never waits. On any other branch, it does nothing. |
| `pre-push` | Runs `review` (the same command as `/devsarathi review`) on the commits being pushed. It prints numbered findings: red flags for secrets and `.env` touches, plus security and peer comments. It **always exits 0** (I-2). If review fails, it prints "Review did not run: <reason>" (I-4). |

**Existing hooks.** DevSarathi detects existing hooks, `core.hooksPath`, Husky or lefthook. It **chains** onto them instead of replacing them, and stores a backup to restore on uninstall.

### 12.2 Claude Code Hooks

| Event | Behavior |
|-------|----------|
| Session start | One-line status: graph age and baseline commit, branch drift, pending approvals, and a new-version notice if one exists |
| Task end (agent stop) | Triggers `ds-tester` when code changed during the task |

### 12.3 Settings Merge (The Only Edit to a Non-Owned File)

If a Claude settings file already exists, DevSarathi:

1. shows the exact entries to add (namespaced, DevSarathi-only),
2. backs up the original,
3. asks for approval,
4. merges.

Uninstall removes only those entries.

---

## 13. Prompt Enhancer

**Inputs:** the developer's request, the spec file or Jira ticket (§14), Drishti impact results, and the relevant rules.

**Output order** (fixed):

1. **Task:** one or two lines.
2. **Spec reference:** the path or Jira key, plus the acceptance criteria IDs.
3. **Relevant files and symbols:** paths and symbol names from Drishti, *references, not pasted code*.
4. **Impact:** affected references with a confidence note.
5. **Constraints:** the core rules reference plus any task-specific constraints.
6. **Acceptance criteria:** from the spec.
7. **Open questions:** gaps or conflicts found in the spec, if any.

**Size.** Target about **400 characters** for simple tasks. The cap is **adaptive**: complex, cross-module tasks may grow up to a configurable ceiling (default 1,500 characters). Compression comes from references, not prose.

**Preview.** The final prompt is shown to the developer before it is sent. Preview is on by default, with a setting to turn it off. Once the developer invokes the command, the rest is automatic: gather context, rewrite, preview, run.

**Ambiguity first.** If the spec is vague or conflicts with the code, the enhancer lists the problems and stops for developer confirmation. It never fills the gaps itself.

**Spec hash.** The hash of the spec is recorded when work starts. `review` warns if the spec changed after that point.

---

## 14. Specs and Jira

- Specs are written and reviewed by **product managers and directors**. DevSarathi **never drafts or edits specs** (non-goal).
- **Sources:** a markdown spec file (from the configured specs path, or passed explicitly), a Jira ticket fetched through a Jira or Atlassian MCP if connected, or a description pasted into the chat.
- Pasted or fetched content is cached read-only in `devsarathi/specs-cache/<KEY>.md` for review traceability. It is cache, not authorship.
- **Jira failure** (MCP down, no access, ticket not found): DevSarathi says so clearly and **asks for a paste**. It never proceeds on partial context.
- `review` checks the finished work against the spec's acceptance criteria.

---

## 15. Security Model

- **Everything is local.** No network calls happen except the opt-in skills step (§19) and the npm version check (registry metadata only, which can be disabled).
- Hooks run only DevSarathi's own Node scripts, with no arbitrary command execution.
- **The secret scanner** covers known key patterns (AWS, GCP, Azure, GitHub, Slack, Stripe, JWT and others), high-entropy strings in assignments, private-key blocks, `.env*` changes, and credentials in config files.
- **Push findings** are red-flag warnings with the file, the line and a masked preview. They **never block** (I-2).
- Secret values are never stored or logged (I-8).
- The VS Code extension and dashboard bind to `127.0.0.1` only. The dashboard server uses a random port and a per-session token.

---

## 16. Metrics and Reports

**Storage.** The source of truth is `devsarathi/metrics/metrics.json`, per repo and local only. The md and docx reports are generated from that JSON so they never disagree.

**What is tracked:**

- Prompts enhanced, and how many were **accepted as-is, edited or rejected**.
- **Turns per task** before and after DevSarathi. This is the strongest proof metric.
- Review findings raised, and findings acted on, by agent and severity.
- Secrets and red flags caught at push.
- Graph builds: count, duration, coverage, and failures.
- Rule changes: auto-applied versus approved versus rejected.
- Agent runs: completed, failed or timed out.
- Tool usage by command, and active days (consistency of use).
- Self-test results over time.

**Baseline capture.** For the first 7 days after init, DevSarathi records turns per task with the enhancer optional. This provides the before-and-after comparison. Acceptance rate is always reported **alongside** turns per task, because acceptance alone can be inflated.

**Privacy.** No prompt text or code is stored in metrics, only counts, hashes and timings.

---

## 17. VS Code Extension (Phase 1 UI)

- **A thin layer:** it calls core or CLI commands and contains no business logic.
- **Background progress notification (bottom-right)** with real stages: *Scanning → Building graph → Generating rules → Generating agents → Installing hooks → Auditing*. It has no time cap. Large repos (2–3 GB) may take minutes while the developer keeps working.
- **Failure notifications** show the error and a **Rerun** button.
- **Sidebar panel:** status, buttons for init, enhance, review, test, refresh, approvals, self-test, skills, dashboard and disable/enable, plus a pending approvals list.
- **Dashboard webview:** the same bundle as the local website (§18).
- **Interactive init:** a wizard for the questions in §5.4.

---

## 18. Local Dashboard Website

- **Started** by `devsarathi dashboard` and served on localhost only (§15).
- **Reads** `~/.devsarathi/registry.json` (the configured repos) and each repo's `metrics.json`, `build-record.json`, reviews and changelog.
- **Shows everything.** At the top, the latest graph build time, branch and commit. Below that, a per-repo graph summary (modules, symbols, coverage), all metrics from §16 with trends, consistency of use, efficiency (turns per task before versus after), review outcomes, rule change history, and self-test history.
- **Commands** are not run from the website. They run in the VS Code terminal, the Claude chat, or through the extension.

---

## 19. Skills Step (Optional, the Only Model Call)

1. Offered **last**, after everything else is complete, and only with opt-in.
2. **Builds a repo summary**: stack, frameworks, test tools, build tools and folder structure from the graph. The summary contains **no source code, no secrets and no env contents**. The developer sees the exact payload before sending.
3. **Sends** the summary to Claude with research enabled, so it can search the market for popular, well-rated skills matching the stack. Official Anthropic skills alone are not enough. Framework skills such as Angular come from the community.
4. **Verifies each suggestion locally:**
   - the source exists and is public,
   - it meets minimum star and activity thresholds,
   - its files are scanned for risky instructions, such as hidden shell commands, network calls or credential access.
5. **Lists all suggestions**, with verified ones first. Each shows the source, rating, last update, a reason and the stack match. Unverified ones appear with a **warning badge and the failure reason**, are **never pre-ticked**, and require a deliberate click.
6. **Ranking** mixes stars, recency and stack match, never stars alone.
7. **Install** happens only for ticked items. It shows the exact source and the pinned version before writing anything into `.claude/skills/`.

---

## 20. Performance and Concurrency

- Heavy work runs in **background worker processes**, and git operations never wait.
- **Locks:** `devsarathi/locks/graph.lock`. A second build request while one runs is queued as **one** follow-up run, never stacked.
- Incremental refresh processes only changed files. A full rebuild happens only on demand or when the graph format changes.
- Stale lock recovery is based on the PID check and a timeout.

---

## 21. Packaging, Versioning and Updates

- **Published as** `@ravikiranm/dev-sarathi` on npm (first publish: `npm publish --access public`). The `bin` field exposes `devsarathi`.
- **Semantic versioning.** Git tags mirror the npm versions.
- **Updates are manual:** `npm i -g @ravikiranm/dev-sarathi@latest`, or pin a specific version. A one-line notice appears at session start when a newer version exists. There is no auto-update.
- **After upgrade:** `devsarathi migrate` shows a diff of the template changes and never overwrites developer edits.
- **Rollback:** install the previous version (`npm i -g @ravikiranm/dev-sarathi@<prev>`), then run `migrate`. This is documented in the README.
- The company-specific overlay is kept **out** of the public core package.
- **License:** chosen by the owner before the first public publish. Placeholder: `LICENSE` TBD by owner.
- **Ownership:** only the owner has git access. Teammates consume the tool through npm only.

---

## 22. Uninstall and Data Removal

- **`uninstall`** removes only DevSarathi-managed files (by `managedFiles[]` and hash), removes its hook entries, **restores pre-existing hooks** from backup, and removes its settings entries. It **keeps** the graph and metrics by default and leaves the developer's own `.claude` files untouched. It shows a preview and asks for confirmation.
- **`remove-graph`** and **`remove-metrics`** are separate. Each shows what will be deleted and its size, then asks yes or no. The metrics prompt warns that deletion is irreversible.
- Uninstall also unregisters the repo from `~/.devsarathi/registry.json`.

---

## 23. Self-Test

`devsarathi selftest` copies a small fixture from `test-fixtures/` into a temp directory. The fixture contains planted problems:

- a fake AWS-style key and a modified `.env`,
- a method with many references across modules, changed without updating its callers,
- a new function with no test,
- a rule contradiction in a generated rules file.

The self-test then confirms the following:

- `ds-security` flags the key and the env change,
- `ds-peer-review` flags the missed references (impact),
- `ds-tester` flags the missing test,
- `ds-auditor` flags the contradiction,
- the pre-push hook exits 0 while printing the red flags.

Results are written to metrics. Failures are shown with details.

---

## 24. Build Plan for the Agent Team

### 24.1 Internal Stages (One Continuous Run, Gated by QA)

1. **Core skeleton:** monorepo, shared types, config, CLI shell, MCP shell, logging, and lock handling.
2. **Detection and Drishti:** stack detection, Drishti multi-language extensions, `DrishtiClient`, graph build, coverage, the baseline model, the overlay, and staleness.
3. **Generation:** templates and profiles, the hybrid rules engine, agents, commands, collision policy, version stamping, the token budget, previews, and the auditor.
4. **Hooks:** git and Claude Code hooks, chaining, settings merge, fail-open behavior, and the kill switch.
5. **Enhance and review:** the prompt enhancer, spec and Jira intake, the review pipeline, the tester flow, and failure handling.
6. **Metrics:** JSON schema, collectors, baseline capture, and the md and docx reports.
7. **VS Code extension:** progress, notifications, sidebar, init wizard, and the dashboard webview.
8. **Dashboard website:** the registry and all views.
9. **Skills step:** summary, research call, verification, and selective install.
10. **Lifecycle:** migrate, uninstall, removals, export-baseline, the version notice, and self-test.
11. **Hardening:** Windows check, large-repo test, docs, README, CHANGELOG, and MAINTAINER.

### 24.2 Approval Gates (Stop and Wait for the Owner)

- **Gate A**, after stage 1 planning: the orchestrator presents its task breakdown and any deviations from this spec.
- **Gate B**, after stage 4: the first working `init` and hooks run on one of the owner's real repos, and the owner reviews the generated `.claude`.
- **Gate C**, before any `npm publish`, any push to a remote, or any change outside the build workspace.

### 24.3 QA Approach

- Unit tests per core module, plus integration tests on `test-fixtures/`.
- **Real-repo tests** on the owner's own Angular, Java and Python repos, run locally. Never copy client repo contents elsewhere.
- **Playwright** for the VS Code webview and dashboard UI.
- The metrics agent verifies that every metric in §16 is collected and appears in JSON, md, docx and the dashboard.
- QA findings go to the orchestrator, then to the developer agent for a fix, then to QA again for a retest.

---

## 25. Definition of Done (Version 1)

Version 1 is done when **all** of the following pass on **one Angular, one Java and one Python repo** from the owner's real set:

- [ ] `init` completes in the background with staged progress, the graph coverage is reported, and nothing pre-existing is modified (I-5).
- [ ] The generated rules match the repo's real conventions, and the auditor reports **clean** or only accepted items.
- [ ] A baseline pull triggers an incremental refresh, and a feature-branch pull triggers nothing.
- [ ] The pre-push hook prints the review findings and red flags and **never blocks**. A crashed review shows "did not run".
- [ ] `enhance` produces an ordered prompt within the adaptive size limit, citing real files and symbols, with the impact list.
- [ ] `review` checks the work against the spec's acceptance criteria and reports the spec-changed warning when relevant.
- [ ] Metrics are recorded, and the JSON, md, docx and dashboard all agree.
- [ ] `selftest` passes on all planted problems.
- [ ] `migrate`, `uninstall`, `remove-graph`, `remove-metrics` and `disable`/`enable` behave as specified.
- [ ] Runs on Windows plus macOS or Linux with Node 20+.
- [ ] The README covers install, commands, upgrade and rollback. MAINTAINER.md is complete.

---

## 26. Phase 2 (Not in Version 1)

- An IntelliJ plugin over the same core (CLI/MCP + `packages/shared`).
- Additional stack profiles, proven to the same standard as version 1.
- Optional team-baseline refresh tooling.

---

## 27. Open Items

- **License choice** before the first public publish (owner).
- **Owner courtesy:** give the company a heads-up before a public publish, since teammates already use Drishti at work.
- **Placement of the Drishti source** into `brain/` (owner).
