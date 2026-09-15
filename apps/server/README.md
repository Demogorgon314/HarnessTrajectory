# @demogorgon314/harness-trajectory

Local viewer for Claude Code, Codex, Kimi Code, and Grok Build transcripts.

```sh
npx @demogorgon314/harness-trajectory@latest
```

Opens `http://127.0.0.1:5170` in the default browser. Pass `--no-open` to skip.

Full-text search is off by default. To index transcripts:

```sh
HARNESS_TRAJECTORY_SEARCH=1 npx @demogorgon314/harness-trajectory@latest
```

Requires Node 22.13+. Listens on `http://127.0.0.1:5170`. See the
[repository README](https://github.com/Demogorgon314/harness-trajectory) for
configuration and development.
