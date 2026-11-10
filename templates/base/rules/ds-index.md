# DevSarathi workspace map

This repo is set up with DevSarathi. Everything below lives in `.claude/` and `.claude/devsarathi/` and stays on this machine. Read this file first: it says what exists, when each piece loads, and what to run.

## Who you are

You work as **{{personaName}}, {{personaTitle}}**. The persona is defined in `.claude/rules/ds-persona.md` (always loaded) and is also available as the subagent `ds-developer`. If another persona file exists in this repo, follow the one the user addresses by name; the standards in the DevSarathi rules apply to all of them.

## Stack

{{stackInline}}

Commands for this repo: test `{{testCommand}}`; lint `{{lintCommand}}`; build `{{buildCommand}}`.

## How to work on a task

1. Run `/ds-status`. It shows how fresh the graph is, whether your branch is behind the baseline, and any rule changes waiting for approval.
2. Read the spec or Jira ticket. It is the source of truth. If it is vague or conflicts with the code, stop and ask. For a short request, run `/ds-enhance "<request>" --spec <path>` to turn it into an ordered prompt with real files, symbols and acceptance criteria.
3. Before you edit any method, function, component, service or API, run `/ds-impact <symbol>` and consider every reference it returns, plus the confidence grade and the reasons for it. The list can miss reflection, DI by string, runtime lookups and dynamic imports.
4. Make the smallest change that satisfies the spec. Follow the stack rules and the conventions below.
5. Add or update tests that follow this repo's test conventions, then {{testHandoff}}.
6. Before you push, run `/ds-review`. It is the same review the pre-push hook runs. Hooks warn and never block.

## Rule files in `.claude/rules/`

{{ruleTable}}

Rules marked "on demand" load when you read or edit a file that matches their paths. Each graph-derived rule carries `source`, `confidence` and `evidence` comments: a rule with low confidence is a hint, not a law, and the developer's own edits always win.

## Subagents in `.claude/agents/`

{{agentTable}}

## Slash commands in `.claude/commands/`

{{commandTable}}

## Where DevSarathi keeps its state

| Path | What it holds |
|------|---------------|
| `.claude/devsarathi/config.json` | Baseline branch, persona, thresholds, kill switch, the list of files DevSarathi owns |
| `.claude/devsarathi/graph/` | The Drishti graph and `build-record.json` (branch, commit, time, coverage) |
| `.claude/devsarathi/reviews/` | Results of every review, test run and audit |
| `.claude/devsarathi/metrics/` | Local metrics (counts and timings only) |
| `.claude/devsarathi/changelog.md` | Every automatic or approved rule change, with its reason |
| `.claude/devsarathi/notices.jsonl` | Notices from hooks and background runs |

## Never

1. Read, print or hard-code secret values. `.env` and key files are never read; only their path is known.
2. Edit a file under `.claude/` that carries a DevSarathi stamp without asking: the developer's edits win, and generated files are refreshed with `devsarathi migrate`.
3. Treat a review, test run or audit that did not complete as a pass. Report "did not run" and why.
4. Work around the kill switch. `devsarathi disable` turns every hook and automatic behavior off; `devsarathi enable` turns them back on.
