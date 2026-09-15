@AGENTS.md

## Claude Code notes

- Before finishing any change: `pnpm typecheck` and `pnpm test` must both pass.
- Verify parser changes against real transcripts in `~/.claude/projects`, `~/.codex/sessions`,
  `~/.kimi-code/sessions`, and `~/.grok/sessions` before relying on synthetic tests alone.
- A `pnpm dev` pair is often already running on 5170/5173; start your own on other ports
  (`HARNESS_TRAJECTORY_PORT`) instead of killing it.
