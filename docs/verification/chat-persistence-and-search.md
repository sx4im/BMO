# Chat persistence and search verification — 2026-11-15

## Persistence behavior

Conversation/user saving runs independently of model generation. Saved IDs are queued to the browser as soon as their writes finish; the URL and sidebar no longer wait until the final answer. The first nonempty assistant text or reasoning is checkpointed, then changed drafts are coalesced with a one-second minimum interval after each completed write. Final sanitized content updates the same assistant row. This is bounded checkpointing, not one database write per token: actual save frequency depends on database latency.

One writer serializes all checkpoints/finalization, retaining only the latest snapshot rather than building a token/write backlog. A final flush waits at most two seconds. If persistence fails or cannot be confirmed in that time, the server reports it; it does not label an unconfirmed reply as saved. An in-flight database operation may finish afterward. A forced process termination can still lose the most recent uncommitted draft; this change does not claim durable queue semantics.

Assistant updates require an owned conversation and match message ID, conversation ID and assistant role. Incognito makes no conversation/message writes. Usage remains once per turn, including reasoning-only responses. Missing-reasoning-column compatibility is restricted to that actual schema error. A failed conversation timestamp touch no longer makes a committed message appear to have failed.

The browser reconciles repeated saved-user acknowledgments by ID without reordering messages. Existing keyed message rendering preserves the streaming bubble. SSE errors, rejected stream reads and premature EOF preserve the received answer/reasoning locally and report unconfirmed saving. Local unconfirmed rows omit feedback/retry database actions; copy/export remains available. No schema migration or new required variable is needed.

## Search behavior

TinyFish requests preserve named subjects, requested places/time wording, and exclusions. Ordinary current-fact questions keep the instant route. News combines one news and one broad-web request concurrently under the existing shared deadline. One additional web page is permitted only for weak meaningful coverage and gets at most 500 ms within that deadline. There is no unlimited search fanout or extra classification call on obvious current queries.

Up to fourteen useful ranked results are retained instead of eight. URLs are validated and deduplicated, tracking/fragment variants normalized, and equally relevant sources spread across domains. Topic relevance precedes recency; dates settle relevant current-result ties. Query cleanup preserves names such as Google. Exclusions do not swallow following positive locations/time qualifiers. Location-only matches do not count as adequate evidence for an otherwise missing subject. Prompt context preserves ranked order, bounds source text, escapes evidence delimiters, and explicitly describes snippets rather than claiming full-page verification.

Lexical ranking is a conservative heuristic. It does not prove semantic relevance, verify every source claim, or guarantee live response time. Full-page reading and broader autonomous research are separate capabilities. TinyFish's API permits purpose/page/date filters; this change uses documented purpose and pagination. It does not infer user location from the server timezone.

## Evidence

- Full suites: **476 backend tests and 143 frontend tests passed**, with 105 existing backend dependency deprecation warnings.
- Independent persistence and search reviews passed after fixing transport partial loss, proper-name cleanup, trailing constraints and weak-coverage detection.
- [Chromium SSE/browser evidence](chat-save-browser.json): early saved IDs update the route before generation ends; repeated acknowledgments keep one user row and the same live streaming DOM node; save failure retains readable text and omits database actions. Server acknowledgments/errors were simulated; frontend SSE parsing/rendering was real.
- [Live provider/read-only database probe](search-and-supabase-live-probe.json): the synthetic Pakistan AI-news request returned fourteen results across nine domains in 2.205 seconds; a Nova-3 Urdu lookup returned ten results across two domains in 1.787 seconds. These are two samples without a before/after benchmark, not latency guarantees. Leading results are recorded for inspection.
- The live Supabase probe selected zero conversation rows, returned HTTP 200 in 0.831 seconds and changed no data. It validates connectivity only. New draft/final write semantics were tested against the isolated tenant-aware database fixture, not by modifying production conversations.

Related scoped UI changes shipped separately in c657a5f: only the centered create action for an empty Projects list; supported file extension hint; mic hover headroom; removed incognito corner title. Those passed thirty-five focused tests, an empty/populated/search/refresh DOM check, and mic bounds checks at 390/1280px in both themes. Existing unrelated Impeccable detector warnings were left untouched.

References: [TinyFish Search API](https://docs.tinyfish.ai/search-api/reference.md), [six-skill research](../bimo-chat-skills-research-2026-11-15.md).
