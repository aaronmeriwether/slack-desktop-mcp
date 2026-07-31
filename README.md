# slack-desktop-mcp

Runs [`korotovsky/slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server)
against the session your **Slack desktop app** is already signed into. No Slack
API tokens to create, store, or rotate.

Prerequisite: `bunx` ([Bun](https://bun.com)). The MCP server binary is
downloaded on first use.

## Register it

`SLACK_WORKSPACE_MATCH` selects the workspace when you're signed into several;
omit it and the last-active one wins.

**Claude Code**

```
claude mcp add slack --env SLACK_WORKSPACE_MATCH=acme -- bunx slack-desktop-mcp
```

**Claude Desktop** — edit its config, then fully quit and relaunch it (the file
is read only at startup):

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "slack": {
      "command": "bunx",
      "args": ["slack-desktop-mcp"],
      "env": { "SLACK_WORKSPACE_MATCH": "acme" }
    }
  }
}
```

Spawn/ENOENT error means the GUI-launched app didn't inherit a PATH containing
`bunx`; use its absolute path (`which bunx`) as `command`.

`slack-desktop-mcp --help` lists the flags.

## How it works

1. A cached session that still passes `auth.test` is used as-is — Slack is never
   touched.
2. Otherwise Slack is launched with `--remote-debugging-pipe` and CDP over the
   inherited fds (no TCP port) reads the `d` cookie and the xoxc token out of
   `localStorage`, then the launched instance is closed again. Both reads are
   polled: the page target exists before the client has written its session.
3. `slack-mcp-server` is fetched from GitHub Releases, cached per version, and
   exec'd with the tokens in its environment — it becomes the MCP server on this
   process's stdio, which is why all logging here goes to stderr.

Slack already running elsewhere owns its single-instance lock, so step 2 fails
fast rather than disturbing that window; quit Slack and retry.

Failures also raise a native dialog, because MCP clients don't surface a stdio
server's stderr. `--no-ui` keeps it headless.

`~/.cache/slack-desktop-mcp/` holds `session.json` (mode 600), the downloaded
binaries, and `refresh.lock`. Only one process may drive Slack at a time: the
holder clears the cached session on acquire and keeps the lock while its dialog
is up, so the cache only ever holds a session some refresh completed. Anyone who
blocks on the lock never launches Slack itself — it re-reads the cache when the
lock frees, and exits nonzero on stderr alone if the holder produced nothing. A
lock older than 120s is treated as abandoned.
