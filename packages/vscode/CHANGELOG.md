# Changelog

## 0.1.0 (preview)
- Sidebar: status, buttons for every command, pending rule approvals with Approve and Reject.
- Staged progress notification for init and other long commands, with no time cap.
- Failures are never quiet: `<command> did not run: <error>` with a Rerun button; hook notices are surfaced too.
- Init wizard: stack confirmation, baseline branch, developer name, a name for each agent, optional Claude-drafted agent guidance, optional CLAUDE.md import block, token budget and a full file preview before anything is written.
- Enhance flow with spec or Jira intake and an Accept, Edit or Reject preview.
- Read-only dashboard panel (127.0.0.1 only, per-session token).
