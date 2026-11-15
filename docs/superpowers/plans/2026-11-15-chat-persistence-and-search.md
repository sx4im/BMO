# Prompt chat persistence and relevant search

Goal: save conversations and streamed assistant drafts promptly while preserving low first-response latency; improve relevant search coverage without serial unbounded provider calls.

Constraints: existing Flask/SSE/vanilla JS/Supabase/TinyFish architecture; no added dependencies, unrelated refactors, or mandatory environment variables. Preserve authentication, tenant ownership, incognito zero message writes, cancellation, attachment context, and usage metering once per turn.

## Persistence

- Keep model generation independent of database latency. One bounded/coalescing writer per active turn owns all assistant writes, first nonempty content/reasoning, changed drafts roughly once per second, then final sanitized content. Update a stable row rather than insert per checkpoint. No per-token threads or growing snapshot queue.
- Publish saved conversation/user acknowledgments through the existing SSE queue as soon as their writes complete, after initial pending events and before final generation. Publish each saved user acknowledgment idempotently; the frontend replaces an existing matching ID rather than appending duplicates.
- Final flush cannot be overwritten by an older checkpoint, and must finish before emitting a saved assistant row. Cancellation/errors/disconnect preserve partial content. Failed or timed-out writes must never be presented as saved. Keep existing fallback semantics and error reporting explicit.
- Scope each new database update to an owned conversation and assistant row. Avoid broad reasoning retries after unrelated failures or reporting an already committed message insert as failed just because conversation-touch failed.
- Behavioral tests: first draft durable before model ends; blocked writes do not delay first token; bounded write count/coalescing; final ordering; cancellation/failed writes; reasoning-only; incognito; duplicate user acknowledgment. Run backend and frontend suites and review.

## Search

- Preserve should_search/run_search/fetch_results/build_search_context contracts. Use original user intent as TinyFish purpose, normalize query wording without dropping named entities/date/place/constraints, and remove blindly appended today's date from general latest queries.
- For news, combine bounded news and broad-web searches concurrently under the existing overall deadline. Add only bounded pagination/query refinement when coverage is weak, respecting provider rate limits. Retain useful source diversity rather than repeatedly selecting one site.
- Normalize and deduplicate URLs; rank by query relevance and requested recency, preserve provider rank where relevance ties. Do not let date-only ordering promote unrelated news. Keep source snippets explicit and never claim full-page verification without fetching.
- Tests: narrow news, ambiguous/current phrasing, multiple domains, duplicates, stale/off-topic/future-dated results, empty/unavailable providers, and overall latency budget. Use authoritative provider API docs for supported parameters only.

## Delivery

Implement persistence/backend, frontend acknowledgment handling, and search in separate owned files. Verify focused red/green tests, full suites, real browser client flow with simulated slow providers, and independent review before pushing focused commits. Real provider relevance/latency and live Supabase durability can only be claimed if actual credentials/test access are available.
