# Landing alignment and persistent context — 2026-11-15

## Change

Keep the hero container aligned with navbar content; apply the compact desktop
scale to the copy and cap the video width at 412px. Mobile retains full-width
content. Refresh stylesheet/module query versions for deployment.

Add tracked engineering instructions and `docs/project-context.md`. They require
Graft context refresh and freshness verification after completed code changes,
and preserve material decisions between sessions.

## Verification

- Frontend regression suite: **153 passed, 0 failed**.
- Actual landing JavaScript module and stylesheet exercised in Chromium at
  390, 768, 1024, 1328, and 1600px. At every width, heading and logo left edges
  matched; video and Try Bmo right edges matched. No horizontal overflow or
  JavaScript errors. Authentication actions were stubbed; video playback and
  provider authentication were outside this layout check.
- Existing installed Graft 0.29.0 CLI executable restored and Codex MCP server
  `graft` registered locally, pointing at this checkout. Registration confirmed
  with `codex mcp get graft`; stdio initialization, tool discovery, and a live
  `graft_repo_map` call succeeded.
  New Codex sessions load the registration.
- `graft build` and `graft check` confirm the deterministic source graph is in
  sync: 1,993 nodes, 4,342 edges. Generated cache remains ignored.
- The optional LLM meaning layer was not built. The MCP freshness response also
  reports its missing `manifest.json` as `NO GRAPH`, then confirms the source
  wiring graph is in sync. Do not confuse that optional layer with a stale source
  graph or enable paid deep indexing without authorization.

The local CLI/configuration is machine-specific; the tracked instructions and
context note travel with the repository. Fresh checkouts rebuild their own graph.
