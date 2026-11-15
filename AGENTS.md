# BMO engineering instructions

Work autonomously from investigation through verification. Understand the relevant
code first, fix root causes, follow existing conventions, and keep changes small.
Do not invent APIs or configuration, modify unrelated work, expose credentials,
or weaken tests. Verify the actual behavior and review the final diff before
claiming completion. Keep updates concise; report changes, verification, and limits.

## Context between sessions

- Read `docs/project-context.md` for the current architecture, recent decisions,
  verification records, and work deliberately deferred.
- Use the Graft MCP tools when connected, or the equivalent `graft` CLI commands.
  Queries refresh their source graph automatically.
- After **every completed code change**, run `graft build` followed by `graft check`
  so both the source graph and generated context cards describe the final code.
  Fix stale context before finishing. Do not use paid `--deep` indexing unless asked.
- Update `docs/project-context.md` when behavior, architecture, deployment steps,
  or deferred work changes. Record verification and limitations, not assumptions.
- Keep generated `graft/` files ignored. On a fresh checkout, run `graft build`.
  If MCP is unavailable, use the CLI; if both are unavailable, report the limitation.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Pick the matching tool and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After completed code changes, refresh the graph with `graft build` and verify
with `graft check` (deterministic, no API key, $0).
<!-- graft:end -->
