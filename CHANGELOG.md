# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

### Releasing

Releases are automated via CI. To create a new release:

1. Add a new entry at the top of this file with heading `## [vX.Y.Z]` (without a
   date). This is a draft — it can be merged to `main` without triggering a
   release.
2. When ready to publish, update the heading to `## [vX.Y.Z] - YYYY-MM-DD` and
   merge to `main`. The date signals "ready to release".
3. The workflow will run tests, create a Git tag, GitHub Release, and npm publish.
4. If the tag already exists, the workflow skips (safe to re-merge).
5. If tests fail, no tag/release is created. The release will be re-attempted on
   each subsequent push to `main`, or can be manually retried from the Actions UI.

Stable versions (e.g. `v1.2.0`) publish to npm `@latest`. Pre-release versions
(e.g. `v1.2.0-rc.1`) publish to npm `@next` and create a GitHub pre-release.

## [v1.0.0] 2026-07-31

Initial release.

### Added
- Runs [`korotovsky/slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server)
  against the session the Slack desktop app is already signed into, so there are
  no Slack API tokens to create, store, or rotate.
- Session cache in `~/.cache/slack-desktop-mcp/`: a cached session that still
  passes `auth.test` is used as-is and Slack is never launched.
- Token refresh over CDP — Slack is started with `--remote-debugging-pipe` and
  the `d` cookie and xoxc token are read off the inherited fds (no TCP port),
  then the launched instance is closed again.
- `slack-mcp-server` is fetched from GitHub Releases and cached per version.
- `SLACK_WORKSPACE_MATCH` selects the workspace when signed into several.
- Single-holder refresh lock, so concurrent invocations never drive the Slack
  desktop app's single instance at the same time. Waiters re-read the cache
  when the lock frees rather than launching Slack themselves.
- Native error dialog on failure, since MCP clients don't surface a stdio
  server's stderr. `--no-ui` keeps it headless.
