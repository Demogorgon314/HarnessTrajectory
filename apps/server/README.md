# @demogorgon314/harness-trajectory

Local viewer for Claude Code, Codex, Kimi Code, Grok Build, Devin CLI, pi, and OpenCode transcripts.

```sh
npx @demogorgon314/harness-trajectory@latest
```

Opens `http://127.0.0.1:5170` in the default browser. Pass `--no-open` to skip.

Full-text search is off by default. Turn on **Content search** in the UI's
settings dialog (applies on the next start), or force it on for a launch:

```sh
HARNESS_TRAJECTORY_SEARCH=1 npx @demogorgon314/harness-trajectory@latest
```

Requires Node 22.13+. Listens on `http://127.0.0.1:5170`. See the
[repository README](https://github.com/Demogorgon314/HarnessTrajectory) for
configuration and development.
