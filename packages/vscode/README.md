# DevSarathi for VS Code

*Sarathi* is the charioteer who steers while the warrior fights. DevSarathi steers you and Claude with the right context: it builds a knowledge graph of your repo, generates a tailored Claude workspace (rules, persona, named agents, slash commands), reviews your changes before you push, and turns short requests into accurate prompts. This extension is a thin layer over the `devsarathi` command-line tool: it contains no logic of its own.

## Requirements
- **Node.js 20 or newer** and **git**.
- The DevSarathi CLI: `npm i -g @ravikiranm795/dev-sarathi`. If it is not on your PATH, set `devsarathi.cliPath`.
- A trusted workspace that is a real git checkout. The extension does nothing in untrusted or virtual workspaces.

## Features
- **Sidebar**: graph age, baseline commit, branch drift, pending rule approvals, kill-switch state, and a button for every command.
- **Init wizard**: detects the stack, asks a few questions (baseline branch, the developer's name, **a name for each agent**), optionally has Claude draft stack-specific guidance for the agent files, shows the token budget and every file before anything is written, and asks before touching your `.claude/settings.json` or `CLAUDE.md`.
- **Staged progress**: Scanning, Building graph, Generating rules, Generating agents, Installing hooks, Auditing, in a notification with no time cap.
- **Failures are never quiet**: `<command> did not run: <error>` with a **Rerun** button. A failed review or test never looks like a pass.
- **Review, test, enhance, refresh, approvals, self-test, skills** from the sidebar or the Command Palette (`DevSarathi: ...`).
- **Dashboard**: a read-only local page (127.0.0.1 only, per-session token) with graph, review and metrics history.
- **Kill switch**: `DevSarathi: Disable` turns every hook and automatic behavior off.

## Privacy
Everything runs on your machine. No telemetry. Source code, secrets and repo data never leave it. Two steps are optional and ask first: the Claude-drafted agent guidance and the skills research. Each shows you the exact text (a stack summary: framework names and top-level folder names) before anything is sent.

## Settings
| Setting | Default | Meaning |
|---------|---------|---------|
| `devsarathi.cliPath` | `devsarathi` | How to start the CLI: a command on PATH, a full path, or `bin/devsarathi.js` (run with `node`). Machine-scoped. |

## Getting started
1. Install the CLI, then open a git repository in VS Code.
2. Run **DevSarathi: Init (set up this repo)** and answer the questions.
3. Open the DevSarathi icon in the Activity Bar.

The command-line tool is the `@ravikiranm795/dev-sarathi` package on npm.
