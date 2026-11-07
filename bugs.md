# Bimo Security Remediation Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task when the user resumes the work. Track progress with the checkboxes. Do not delegate unless the user or applicable repository instructions authorize delegation.
>
> **Current instruction: implementation authorized by the active user goal on 2026-11-03.** Fix the documented findings, verify the behavior, and keep the connected-account deployment handoff separate from version control. The planning-only restriction below is historical. Do not change production resources automatically.

## Implementation status

Work is on `fix/bimo-security-and-frontend`. Connected-account setup is delegated through a private agent handoff kept outside this repository. A local test result does not mean a production configuration has changed.

| Area | Implemented and locally verified | Owner / release work |
| --- | --- | --- |
| BIMO-01 / BIMO-02: data permissions | Forward migration0010 removes client share enumeration and usage mutations. Gateway-only sharing and no-store responses; real Postgres role checks. | Apply migrations and confirm live grants/cache rules. |
| BIMO-03: authoritative budgets | Migration0011 atomically admits each paid attempt; outages fail closed, uncertain work stays charged, holds count toward allowance, and anonymous global spend survives account deletion. All model/media/search/scrape/WhatsApp boundaries are covered; unknown vision models require documented bounds. | Configure affordable global ceilings and independent provider spending caps; reconcile uncertain settlements. |
| BIMO-04 / BIMO-07: voice | One-use Redis tickets replace login JWT URLs; per-user/global leases, character admission, frame/command/session/idle bounds, lazy provider opening and expiry checks. REST transcription validates bounded PCM audio; client recording/late-callback cancellation repaired. | Provision Redis, release matching client/server versions, test actual audio/providers/devices. |
| BIMO-05: shared counters | Production requires shared Redis; process/restart/namespace/outage tests use real Redis. No memory fallback in production. | Provision TLS/ACL/capacity/persistence and monitor service health. |
| BIMO-06: actual API edge | Fixed-upstream Worker, constant-time origin gate, trusted IP overwrite, bounded rotation, exact CORS and backend-verified Turnstile with session-bound clearance. Missing production settings fail closed. | Choose/verify API domain, deploy Worker, set secrets/WAF/cache/DNS and the four public frontend settings. No account connector was available. |
| BIMO-08: privacy and WhatsApp | Safe logs/errors/request IDs; keyed sender pseudonyms, bounded/deduplicated background jobs and history cleanup. Migration0012 prunes old external metadata without refunding global spend. | Replace the old public verification value, configure stable pepper/Meta HMAC, schedule retention and account for backup retention. |
| BIMO-09: vulnerable dependencies | Reviewed Python/npm/browser fixes, compatible Riva runtimes, vendored DOMPurify with provenance, exact browser versions, redacted secret scanning and OSV metadata checks. | Run current advisory checks at release; native/transitive CDN coverage limitations are in the verification record. |
| FE-01–FE-13 | Route/auth ownership, draft recovery, cancellation/stream EOF, deliberate sharing, dialog focus, Projects native keyboard controls, focus intent, contrast and usage Retry are repaired with regressions. | Physical-device, screen-reader and live-provider checks remain manual. |
| Additional integration fixes | Denied image work no longer persists a draft the browser restores. Compact verification widget fixes reproduced320px overflow. Client build/entrypoint versions updated for release. | Follow coordinated maintenance release; do not publish blank gateway settings. |
| Verification checkpoint | **488 backend tests /110 frontend tests** pass in networkless containers; real SQL permissions, retention and concurrent admission plus real Redis fresh-process tests pass. Local browser checks cover320/375/1440 widths, both themes, explicit sharing/focus and computed control contrast. | Fresh portable-install verification and final whole-branch review are being completed; production evidence is not claimed. |

The detailed findings below describe the original reviewed revision. Their line references and initial acceptance checklists are historical; this status table and the final verification record describe the remediation branch. **Account changes, live deployment and device checks are coordinated separately through the private agent handoff.**

**Goal:** Prevent shared-chat enumeration and quota bypass, bound AI and voice resource consumption, and protect the actual API through Cloudflare without breaking normal chat, sharing, uploads, or voice.

**Architecture:** Keep the existing Vercel frontend, Render Flask gateway, and Supabase database. Make the gateway authoritative for public share lookup and usage accounting, use Postgres transactions for quota admission, and use shared Redis for request counters and short-lived voice tickets. Add Cloudflare at the API boundary with authenticated access from the edge to Render.

**Tech stack:** Vanilla JavaScript ES modules, Flask, Flask-Limiter 4.1.1, Gunicorn, Supabase/Postgres and Storage, Deepgram, NVIDIA/Groq/Mistral, Vercel, Render, and Cloudflare. The Redis integration and Cloudflare Worker are implemented in this branch; their live infrastructure is an owner setup action.

**Spec:** The user's security-review request, the findings below, and the explicit instruction to prepare `bugs.md` and stop. Proposed settings in this plan are engineering defaults, not requirements previously supplied by the user.

**Prepared:** 2026-11-02, Asia/Karachi. Intended next working day: 2026-11-03.

**Reviewed source:** `1b4b6d8a6a53ca8ca51397f89dad4d4a7a149d2e`; worktree was clean before this document was created. Recheck the revision before implementation. Source line references below describe that revision.

## Findings added during implementation — 2026-11-07

- **BIMO-09 — affected runtime/browser dependencies.** Primary OSV/upstream advisory lookup identified affected installed versions of Pillow, PyJWT, cryptography, Werkzeug, urllib3, certifi, h2, aiohttp/multidict/yarl and DOMPurify/KaTeX; the frontend development lock also needed source-map-js and undici patches. The original Riva package pinned vulnerable setuptools; its update required newer generated gRPC/protobuf runtimes than its loose metadata advertised. Compatible patched versions are pinned/tested, and DOMPurify is vendored with verified package/module provenance. A clean OSV result covers matching package/version advisories, not every bundled native library or generated CDN dependency. See the dependency manifests and recorded package-audit limitations.
- **BIMO-03 extension — deletion and media admission.** Real concurrent SQL reproduced why global counters must survive account deletion. Vision reservation tests reproduced undercharging for tiny compressed image URLs; documented per-image bounds now apply. Image route tests reproduced conversation/draft writes before quota denial; denied generation now leaves the recoverable draft unpersisted.
- **BIMO-08 extension — external delivery/history bounds.** WhatsApp lacked bounded background delivery/deduplication and inactive-history cleanup. Shared hashed event claims, bounded jobs, hourly history cleanup and service-only external-usage retention now have regression/real-database checks. Background delivery is still best effort after worker crashes, as documented.
- **FE-14 — verification dialog mobile overflow.** A browser fixture modeling Cloudflare's300px flexible minimum reproduced a frame extending to347px on a320px viewport. Compact widget sizing fits; real widget/assistive-technology interaction remains an owner staging check.

## Global constraints

- Preserve existing Supabase login, ownership checks, snapshot-only sharing, attachment authorization, model lanes, incognito privacy, and cancellation behavior.
- Add forward migrations after `0009_customize.sql`; do not silently rewrite already-applied migrations. Proposed filenames below must be renumbered if newer migrations exist when work resumes.
- Keep secrets out of source, frontend bundles, URLs, test fixtures containing real values, and logs. The Supabase publishable key in frontend configuration is intentionally public; it is not a leaked service-role key.
- Keep source changes focused. Do not migrate the whole application to Workers, redesign the UI, replace providers, or start an unrelated dependency upgrade.
- Keep the existing five-hour limit of 100,000 weighted tokens and seven-day limit of 1,000,000 weighted tokens unless the user later changes the product policy. Current weights are `thinking=1`, `deep=5`, `image=5`, `aeon=1`; image generation currently counts 3,000 raw units, or 15,000 weighted units.
- Treat source observations separately from deployed configuration. No live Cloudflare account API or Supabase configuration was available during review. Do not describe a production exploit as reproduced.
- Prepare and verify all code/configuration before requesting approval for a concrete deployment or live configuration change. Obtain explicit approval for external mutations; do not ask for secret values in chat.
- Run application code and security tests only in an OS-enforced sandbox: no external network, explicit safe environment allowlist, scratch-local home/cache/state, read-only source/toolchain, scratch-only writes, and bounded resources. Use an isolated loopback namespace for local Postgres/Redis integration tests. If these controls are unavailable, record the blocked verification and do not execute target-controlled code unsandboxed.

## Findings and evidence

Priorities describe remediation order, not a claim of verified production severity. All source observations below were inspected; database exposure still depends on deployed migrations, grants, and Data API settings.

| ID | Priority | Finding and source evidence | Security outcome / evidence boundary |
| --- | --- | --- | --- |
| BIMO-01 | First | `backend/migrations/0006_shared_conversations.sql:24` creates a public SELECT policy with `using (true)`. `frontend/js/api.js:237` directly queries that table as a fallback. | With client SELECT grants, a caller can enumerate shared snapshots without possessing their links. This affects published snapshots, not every private conversation. The policy is source-confirmed; deployed grants and exposure are not checked. |
| BIMO-02 | First | `backend/migrations/0003_usage_events.sql:21` grants owner access through a `FOR ALL` policy. `backend/app/store.py:464` reads these events to determine usage. | With client mutation grants, a signed-in user can delete/change their usage records or insert misleading records and bypass the intended quota. No forward migration reviewed revokes these grants. Live permissions require validation. |
| BIMO-03 | Next | `backend/app/routes/helpers.py:102` converts a usage-read exception into `events = []`. `backend/app/store.py:451` logs and swallows usage-write errors. Generation checks usage before recording completed work, for example `backend/app/routes/media_routes.py:78` and `:152`. | A metering outage is treated as zero consumption. Separate check/record operations also need concurrency validation. Failure behavior is source-confirmed; concurrent quota overrun has not been reproduced. |
| BIMO-04 | Next | `backend/app/routes/media_routes.py:333` authenticates voice connections; `backend/app/deepgram_tts.py:116` forwards client messages to Deepgram without an application character budget or session deadline. | An authenticated user can consume provider resources beyond an application voice budget because no such budget is enforced in this path. Provider-side limits and billing remain external constraints. |
| BIMO-05 | Next | `render.yaml:9` starts two Gunicorn workers; `render.yaml:63` configures `memory://` limiter storage. The same default exists in `backend/app/main.py:84` and `backend/app/limiter.py:30`. | Request counters are independent per process and disappear on restart. These are verified repository settings; production environment overrides were not inspected. |
| BIMO-06 | Before edge rollout | `frontend/js/config.js:23` defaults to a direct `onrender.com` API origin. No edge-origin authentication was found in the reviewed request pipeline. | Protecting only the frontend hostname does not put these API calls through Cloudflare. Live DNS, WAF coverage, and any external origin restriction are not checked. |
| BIMO-07 | With voice work | `frontend/js/api.js:587` places the Supabase access token in a WebSocket query string; `backend/app/routes/media_routes.py:335` consumes it there. | The URL contains a reusable login credential. Exposure through access logs or tracing needs validation; do not claim that logs were inspected or that a token was stolen. |
| BIMO-08 | Hardening | `backend/app/whatsapp.py:402` logs the sender's phone number and full message. `render.yaml` includes a literal WhatsApp verification value. | Confirmed privacy/secret-management weaknesses. The verification value is not the Meta HMAC signing secret; its disclosure alone does not bypass the POST signature check, which already fails closed. |

Additional controls to add: backend-verified Turnstile for selected browser entry points, global provider-consumption ceilings, useful abuse alerts, least-privilege cloud access, and automated permission regression tests. Their absence alone is not reported as a confirmed exploit.

## Review focus

1. Anonymous or authenticated clients must not list all snapshots; a valid share link must still work, and revocation must stop subsequent lookup. Owned by Task 1.
2. Parallel requests, retries, disconnects, and worker crashes must not admit unreserved provider work, double-charge, or silently erase consumption. Owned by Task 3.
3. Redis/Postgres outages must have explicit behavior without falling back to fresh local counters or treating usage as zero. Owned by Tasks 3 and 4.
4. Voice reconnects, delayed ticket responses, interruption, oversized frames, and stale browser assets must preserve both authorization and normal playback. Owned by Task 5.
5. Edge rules must preserve SSE, WebSocket upgrades, CORS preflight, 50 MB uploads, health checks, and signed Meta webhooks. Owned by Tasks 6 and 7.

## Implementation sequence

Complete Tasks 0–5 before enabling new Cloudflare enforcement. Prepare Tasks 6–8 locally, then perform the staged rollout in Task 9. Local test preparation is authorized only when the user resumes implementation; this planning session changes only `bugs.md`.

### Task 0: Re-establish the baseline and obtain missing evidence

**Existing files:** `render.yaml`, `vercel.json`, `backend/app/main.py`, `backend/app/config.py`, `backend/tests/conftest.py`, `backend/tests/test_regressions.py`, `docs/CUSTOMIZE.md`.

**Produces:** A current source baseline, a non-secret deployment inventory, and runnable isolated test environments. Record progress and evidence in this file.

- [ ] Check Git status, current commit, local instructions, migration numbering, available tools, and existing dependencies. Preserve unrelated work.
- [ ] Use available authorized read-only integrations to inspect deployed database policies/table grants, exposed schemas, API availability, limiter storage overrides, Cloudflare zones/plans/rules, Render origin restrictions, and provider quota settings. Inspect metadata, not database rows, chat content, or secret values. Mark unavailable evidence explicitly.
- [ ] Confirm control of a proxied API hostname; `api.bimo.qzz.io` is a proposed hostname, not a verified configured resource. Confirm Workers availability and Redis connectivity before promising rollout.
- [ ] Record operator-set daily consumption allowances from verified provider entitlements and acceptable application usage. Keep allowances in named resource units; do not invent token prices or describe an estimated unit ceiling as a guaranteed dollar spending limit.
- [ ] Prepare an isolated Postgres harness with `auth.users`, `auth.uid()`, `anon`, `authenticated`, and `service_role`; reuse the approach documented for `backend/tests/customize_rls.sql`. Use dummy users A and B only. Run a private Redis instance for integration checks.
- [ ] Prevent startup network side effects in tests: `backend/app/main.py` can prewarm JWKS and call inference during import. Stub network boundaries before import as needed; disabling dotenv alone is insufficient. Do not remove production authentication to make tests run.
- [ ] Run the existing backend/frontend suites in the sandbox and record baseline failures separately. Start with limits of two CPUs, 1 GiB RAM, 128 processes, 512 MiB scratch, bounded output, and ten minutes per suite; adjust explicitly if a legitimate suite needs more.

**Acceptance:** We know what is verified locally, what is configured live, and what remains unavailable. The test harness cannot reach real Supabase or provider endpoints.

### Task 1: Make share access depend on possession of a link

**Modify:** `frontend/js/api.js`, `backend/app/routes/user_routes.py`, `backend/app/store.py`, `backend/tests/test_share.py`, `backend/tests/test_regressions.py`.

**Create, proposed:** `backend/migrations/0010_security_permissions.sql`, `backend/tests/security_rls.sql`, `frontend/tests/security.test.mjs`.

**Interfaces:** Preserve the existing create/read/delete owner endpoints and anonymous `GET /share/<share_id>` response shape. Keep existing share IDs working.

- [ ] Add real-database regression cases proving that `anon` and `authenticated` cannot enumerate shared rows, including after deliberately applying legacy permissive client grants in the fixture. Assert actual returned data/denials, not merely successful SQL execution.
- [ ] Add API tests for valid, malformed, missing, and revoked share IDs; owner-only create/update/delete; frozen snapshots; and attachment signing constrained to the snapshot owner's paths. A private turn added after sharing must not appear in the snapshot.
- [ ] Add frontend tests where the gateway fails and assert that share operations surface a retryable error without querying `shared_conversations` directly.
- [ ] Remove the public read policy and revoke direct client privileges on `shared_conversations`. Keep the backend service role able to manage shares. Remove direct-table fallbacks for create, metadata lookup, deletion, and public lookup together.
- [ ] Keep public responses limited to the intended snapshot fields, without leaking owner IDs or unrelated private records. Add `Cache-Control: no-store` to share lookup responses so revocation is not defeated by a newly introduced shared cache. Document that already downloaded content and previously issued signed attachment URLs cannot be recalled instantly.
- [ ] Run the new SQL tests, existing share/attachment regression tests, and frontend security tests. Check that the forward migration is transaction-safe and can be rerun according to repository conventions.

**Acceptance:** No client role can list the table, every existing valid link still loads through the gateway, and an invalid/revoked link returns 404. During a gateway outage, sharing shows an error rather than bypassing the gateway.

### Task 2: Make usage records writable only by the server

**Modify:** Proposed `0010_security_permissions.sql`, `backend/app/store.py`, `backend/tests/security_rls.sql`.

**Create, proposed:** `backend/tests/test_usage_security.py`.

**Interfaces:** Preserve `GET /usage` and the existing trailing-window response fields. Preserve legitimate server-side account deletion.

- [ ] Add SQL tests showing that users cannot insert, update, delete, or truncate usage records, including their own records. Test both roles and attempts to fabricate negative usage, change timestamps, and assign another user's ID. Test service-role recording separately.
- [ ] Drop the permissive owner-write policy. Explicitly revoke client mutation privileges, including inherited/default table privileges that would bypass the intended policy; retain only necessary owner-scoped SELECT access. Inspect effective privileges, not just policy text.
- [ ] Add a database nonnegative constraint for token counts. Inspect existing invalid data through non-secret aggregate checks before validation; do not delete or rewrite production rows automatically.
- [ ] Verify the actual gateway Supabase client continues to use its server role and that user authorization remains enforced in gateway functions.
- [ ] Run SQL permission checks against real Postgres plus Python usage regressions. A Python database double is not proof of RLS enforcement.

**Acceptance:** The client cannot rewrite its consumption; server recording and owner-scoped usage display still work. Account cleanup still obeys the intended privacy policy.

### Task 3: Enforce budgets atomically and fail closed before paid work

**Modify:** `backend/app/store.py`, `backend/app/routes/helpers.py`, `backend/app/routes/chat_routes.py`, `backend/app/routes/media_routes.py`, `backend/app/config.py`, `backend/tests/test_regressions.py`.

**Create, proposed:** `backend/migrations/0011_usage_reservations.sql`, `backend/app/usage_service.py`, `backend/tests/test_usage_reservations.py`.

**Proposed Python interfaces:** `reserve_usage(user_id: str, request_id: str, resource: str, units: int) -> dict`, `settle_usage(user_id: str, request_id: str, used_units: int) -> None`, and `cancel_usage(user_id: str, request_id: str) -> None`. The reservation result contains the request ID and reserved units. Define explicit quota-exceeded and metering-unavailable exceptions. These interfaces are new work, not existing APIs.

- [ ] Add concurrent admission tests at the five-hour and weekly boundaries, idempotent retry/settlement tests, and provider-side-effect assertions: rejected or unmetered requests must never call the provider.
- [ ] Introduce a private reservation table and transactional Postgres RPCs. Serialize admission for each user and the global daily allowance, using database time and consistent lock ordering. Count committed usage plus outstanding reservations. Keep private tables inaccessible through client grants and exposed schemas.
- [ ] Use explicit `SECURITY INVOKER` RPCs callable only by `service_role`, with schema-qualified references and fixed search paths. Revoke default function execution from `PUBLIC`, `anon`, and `authenticated`; test those denials.
- [ ] Generate request identifiers on the server or strictly bind accepted idempotency identifiers to user/resource/payload. A caller must not reuse another request's reservation to obtain extra work.
- [ ] Reserve a conservative maximum before inference, image generation, or a billable auxiliary operation. Bound input and provider output so admitted work fits the reservation, including document batches, continuation calls, retrieval, and background title/image-description calls. Keep existing usage weights and image accounting.
- [ ] Settle once using trustworthy provider usage where available; otherwise use a documented conservative estimate. A disconnect, exception, or crashed worker must retain a conservative charge until safely reconciled. Never automatically refund an expired reservation if provider work might already have happened.
- [ ] Replace `get_usage_status()`'s exception-to-zero fallback with an explicit unavailable state. Return 503 before new provider work when authoritative accounting cannot be read/reserved; return 429 for a genuine exhausted quota. Preserve a completed streamed answer if settlement fails, retain the reservation, and alert for reconciliation.
- [ ] Add operator-configured global daily ceilings per resource. A production deployment must not silently treat a missing/invalid required allowance as unlimited. Keep independent provider-side spending limits where the provider supports them.
- [ ] Inventory every paid entry point: saved/incognito chat, images, REST/streaming TTS, transcription, standalone search/scrape, background calls, and WhatsApp. Apply resource admission to each; bind WhatsApp usage to a server-derived sender identity and the same global ceiling without inventing a Supabase user for it.
- [ ] Test that deleting chat content cannot be used to reset an active account's abuse allowance. Respect actual account deletion and approved data-retention rules; do not introduce indefinite phone-number/user tracking.
- [ ] Run real-Postgres concurrency tests and route tests for normal completion, partial output, cancellation, retries, account cleanup, database failure, and global ceiling exhaustion.

**Acceptance:** No paid operation starts without admission, simultaneous requests cannot oversubscribe an allowance, completed work is accounted once, and accounting outages do not grant fresh quota.

### Task 4: Share request counters across all workers

**Modify:** `backend/app/limiter.py`, `backend/app/main.py`, `backend/requirements.txt`, `render.yaml`, `backend/.env.example`, relevant tests in `backend/tests/test_bimo.py`.

**Create, proposed:** `backend/tests/test_rate_limit_storage.py`.

**Interfaces:** Preserve verified-user rate-limit keys and the existing JSON 429 response. Memory storage remains an explicit local/test option only.

- [ ] Confirm the Redis driver supported by the installed Flask-Limiter/limits versions and add the smallest supported pinned dependency or extra. Do not guess a client API or install anything during this planning session.
- [ ] Make production limiter configuration require shared storage. Store the connection credential in deployment secrets, use TLS where the service requires it, use an application/environment key prefix, and set bounded connection/operation timeouts.
- [ ] Configure failure behavior explicitly: protect expensive routes when Redis is unavailable instead of silently accepting requests with fresh memory counters. Keep inexpensive liveness checks independent of Redis.
- [ ] Add a two-worker test against isolated Redis: alternate requests between processes and assert one combined limit. Restart one worker and assert its quota does not reset. Test namespace separation and backend failure behavior.
- [ ] Keep IP-based limits supplementary to authenticated-user limits. Do not trust arbitrary `X-Forwarded-For` or `CF-Connecting-IP`; change proxy handling only after the trusted edge path in Task 6 exists.

**Acceptance:** All workers share counters, restart does not reset them, and Redis failure is visible and bounded. Verify actual 429 behavior, not just successful Redis connectivity.

### Task 5: Bound voice consumption and remove login JWTs from URLs

**Modify:** `backend/app/routes/media_routes.py`, `backend/app/deepgram_tts.py`, `backend/app/config.py`, `frontend/js/api.js`, `frontend/js/components/voice-overlay.js`, `backend/tests/test_deepgram_tts.py`, `frontend/tests/voice.test.mjs`.

**Create, proposed:** `backend/tests/test_voice_security.py`.

**Interfaces:** Add bearer-authenticated `POST /tts/ticket` returning `{ticket, expires_in}`. Change the stream URL to `/tts/stream?ticket=...`; `ttsStreamUrl` consumes a ticket rather than a login JWT. Update all callers and add an async ticket-request helper. Redis stores only a hash of the opaque ticket plus minimal bound identity/settings, with a 30-second TTL and atomic single-use consumption across workers.

- [ ] Add tests for unauthenticated ticket creation, expired/replayed tickets, concurrent replay, a ticket for another resource, logout/reconnect behavior, and rejection of reusable login JWT query parameters after cutover. Never log tickets or return them in error URLs.
- [ ] Validate the ticket, trusted request path, per-user concurrency, and usage reservation before opening Deepgram. Use a shared expiring connection lease so one worker cannot ignore another worker's open stream; release it on every close path.
- [ ] Validate client commands rather than forwarding arbitrary frames. Allow only the commands actually used by Bimo and supported by the chosen Deepgram endpoint; reject malformed JSON, unknown commands, and unsupported binary client frames before upstream forwarding.
- [ ] Start with proposed configurable limits of 4,000 text characters per Speak command, 30,000 characters per user per UTC day across REST and streaming TTS, two concurrent streams per user, 15 minutes per connection, and 60 seconds without meaningful client activity. Confirm these values against legitimate voice usage before production enforcement. Control-only spam must not indefinitely extend a stream.
- [ ] Use Task 3's server-side budget admission before each billable text chunk. Apply the same character accounting to REST TTS. Return structured quota errors without forwarding the rejected chunk, and close/release resources on expiry, interruption, or failure.
- [ ] Use fake clocks and provider sockets to test limits without long sleeps. Test oversized messages before upstream forwarding and before unbounded parsing/buffering. Set supported WebSocket frame limits at the server boundary after checking the installed library API.
- [ ] Update voice prewarming/reconnect logic to fetch fresh tickets and ignore late ticket responses after unmount/cancel. Preserve language/model selection, speed, expressivity, interruption, and Flux/Aura command translation.
- [ ] Stage the backend ticket endpoint before the frontend switch, invalidate stale frontend assets with the existing version-management mechanism, then disable the old JWT-query path. Set a concrete cutover point; do not retain a permanent insecure fallback.

**Acceptance:** A login JWT is absent from WebSocket URLs, tickets work once across workers, active streams obey budgets/deadlines, and legitimate voice regressions pass.

### Task 6: Put the actual API behind Cloudflare and protect Render

**Modify:** `frontend/js/config.js`, `backend/app/main.py`, `backend/app/config.py`, `render.yaml`, `backend/.env.example`, `vercel.json` as required by the final API hostname.

**Create, proposed:** `edge/worker.js`, `edge/wrangler.jsonc`, `edge/tests/worker.test.mjs`, `backend/tests/test_edge_access.py`, `docs/SECURITY_ROLLOUT.md`.

**Interfaces:** Route requests through the verified proxied API hostname. A small gateway Worker forwards only to a configured fixed Render origin and supplies `X-Bimo-Edge-Token` from a Worker secret. Flask verifies it using constant-time comparison. The browser never receives this token.

- [ ] Verify current Cloudflare/Render documentation and plan entitlements before preparing deployable configuration. Use an existing secure origin restriction instead if live inventory proves an equivalent control already exists; document that decision and avoid redundant infrastructure.
- [ ] Test origin rejection for missing/incorrect tokens and acceptance for valid edge requests before touching DNS. Only explicitly documented minimal health checks may bypass the origin gate; verify their responses expose no private configuration.
- [ ] Make the Worker overwrite any caller-supplied edge-token header, use a fixed upstream origin, preserve method/path/query/auth/body, and prevent secret-bearing requests from following redirects to other origins. Forward bodies and SSE without full buffering; support WebSocket upgrades.
- [ ] Use secrets in both Cloudflare and Render; do not place their values in Wrangler, YAML, source, or this document. Support a short, controlled dual-secret rotation window to avoid downtime.
- [ ] Add Cloudflare WAF protection and path-scoped request limits compatible with the actual plan. The Free Managed Ruleset is available on all plans; Free rate limiting currently provides one IP-counted rule, so application user limits must remain authoritative. Do not promise paid features on an unverified account.
- [ ] Bypass CDN caching for authenticated/personalized API responses and share lookups; verify no cross-user cache reuse. Narrow production CORS to actual frontend origins, leaving local origins in local development configuration.
- [ ] Test ordinary fetches, preflight, SSE, WebSocket upgrades, a 50 MB attachment, custom-domain TLS, and health checks. Test direct-origin rejection in an isolated fixture first.
- [ ] Move Meta's webhook URL to the edge before enforcing the Render origin gate; preserve HMAC signature checking. Do not protect Meta webhooks with a browser challenge.

**Acceptance:** Browser API traffic traverses Cloudflare, direct Render access cannot skip the edge gate, and all supported transport paths remain functional. This acceptance requires an approved live rollout; source tests alone do not prove DNS/WAF coverage.

### Task 7: Add backend-verified Turnstile without breaking API clients

**Modify:** `frontend/index.html`, `frontend/js/api.js`, `frontend/js/auth.js` where integration requires it, `backend/app/main.py`, `backend/app/config.py`, `vercel.json`.

**Create, proposed:** `backend/app/turnstile.py`, `backend/tests/test_turnstile.py`; extend proposed `frontend/tests/security.test.mjs`.

**Proposed interface:** `verify_turnstile(token: str, *, expected_action: str, expected_hostname: str, remote_ip: str | None) -> None`. Reject invalid/expired/reused proofs; represent provider unavailability separately. The widget site key is public; the validation secret is server-only.

- [ ] Choose the control boundary explicitly: verify a browser session before first expensive API use and issue a bounded, server-controlled abuse-clearance lease tied to the authenticated session. It supplements the Supabase JWT and quotas; it never replaces them.
- [ ] Confirm the current Supabase OAuth flow before deciding whether to use its supported CAPTCHA integration. A challenge added only before an OAuth redirect must not be claimed to protect direct generation calls.
- [ ] Call Siteverify on the backend with a short timeout; verify success, expected hostname, and expected action. Never trust the frontend's boolean or merely the existence of a token. Do not reuse a single-use proof on every request; use the separate bounded lease after successful verification.
- [ ] Test direct API calls with missing/forged proofs, wrong hostname/action, replay, expiry, provider failure, legitimate token refresh, and clearance binding. Fail before paid side effects when mandatory verification is unavailable.
- [ ] Keep server-to-server Meta webhooks on HMAC authentication and documented exceptions, with Task 3 budgets. Do not add a blanket bypass based on `User-Agent`, CORS headers, or a caller-declared client type.
- [ ] Update CSP with only the Cloudflare sources required by current official guidance. Test the widget alongside existing markdown, fonts, Supabase, SSE, and voice behavior.

**Acceptance:** Automated direct calls cannot bypass the enforced browser clearance, legitimate sessions do not receive a challenge for every streamed chunk, and webhook delivery remains intact.

### Task 8: Add abuse visibility and reduce sensitive logging

**Modify:** `backend/app/whatsapp.py`, `backend/app/auth.py`, `backend/app/routes/media_routes.py`, `render.yaml`, `backend/.env.example`, proposed `docs/SECURITY_ROLLOUT.md`.

**Create, proposed:** `backend/tests/test_security_logging.py`.

- [ ] Add structured events for quota denials, accounting failures, excessive voice consumption, invalid/replayed tickets, invalid edge authentication, Redis failure, and global provider ceilings. Use request IDs/resource/count/outcome rather than message content or reusable credentials.
- [ ] Remove WhatsApp full-message logging and raw phone numbers from ordinary operational logs. Remove token previews and raw upstream error bodies from client-facing diagnostics where unnecessary. Verify `DEBUG_AUTH` and Flask debug mode remain disabled in production.
- [ ] Replace the literal WhatsApp verification value with a deployment-managed secret and coordinate Meta configuration if it changes. Preserve `WHATSAPP_APP_SECRET` HMAC verification; do not confuse the two secrets. Rotation is a later approved live action, not part of writing this plan.
- [ ] Configure alerts for metering failures, Redis outages, unusual provider consumption, sustained quota/edge denials, and configured daily thresholds. Set recipients and delivery channels through authorized operational configuration; do not send messages or notifications during implementation without authorization.
- [ ] Review account access using available metadata: MFA on Cloudflare/Render/Vercel/Supabase administrators, scoped deployment tokens, separate preview credentials/data, and recovery ownership. Mark unavailable controls as not checked rather than absent.
- [ ] Add permission tests and security regression suites to the existing CI mechanism if one is available; if none exists, prepare a minimal workflow without exposing production secrets to pull-request code. Add dependency/secret scanning with a documented scope, avoiding an unrelated upgrade sweep.
- [ ] Use captured dummy log output to assert that bearer tokens, ticket strings, edge tokens, service keys, phone numbers, and message bodies are absent.

**Acceptance:** Operators can detect a broken control or cost spike without ordinary logs collecting conversations or login credentials. Metadata-only access checks and required live changes are documented honestly.

### Task 9: Verify, review, and roll out in dependency order

**Modify:** This checklist and proposed `docs/SECURITY_ROLLOUT.md`; only task-owned source/configuration files should otherwise change.

- [ ] Run focused regression tests after each implementation task, then the full backend and frontend suites once the combined changes are ready. Fix root causes; do not weaken tests or hide errors.
- [ ] Run real Postgres permission/concurrency tests and the Redis two-worker/ticket-replay tests. Database/client mocks cannot substitute for these assertions.
- [ ] Exercise the assembled application in an isolated browser fixture with dummy accounts, local services, and fake providers: sign in, chat, incognito, project chat, image generation, upload, share/unshare, voice reconnect/interrupt, and usage exhaustion. Assert that rejected requests produce zero provider calls.
- [ ] Review the final diff for tenant isolation, grants/function privileges, accidental secret exposure, unbounded parsing, race conditions, dead fallback paths, and unnecessary dependencies. Check every finding against its acceptance criteria and record remaining gaps.
- [ ] Prepare a concrete release bundle: migration order, code revisions, non-secret configuration names, chosen limits, expected user-visible errors, migration verification queries, transport checks, rollback steps, and any unavailable live evidence.
- [ ] After explicit approval, deploy gateway/frontend changes that remove direct share fallbacks before revoking the table grants, or use a coordinated maintenance window. Apply restrictive permissions promptly; if active exposure is confirmed, prioritize containment over gateway-outage fallback availability.
- [ ] Apply reservation migrations before enabling reservation-dependent application code. Provision/configure Redis before switching production counters or voice tickets. Deploy the ticket endpoint before frontend cutover; then enforce ticket-only WebSockets.
- [ ] Bring up the edge gateway with authenticated upstream forwarding; validate the new hostname, move browser/webhook traffic, and only then require edge authentication at Render. Verify with synthetic owned fixtures rather than inspecting other users' data.
- [ ] Enable Turnstile/edge blocking in a controlled rollout, checking false positives and provider health. Keep expensive API rejection as API responses; avoid returning browser challenge HTML inside SSE or WebSocket message streams.
- [ ] Observe errors, latency, quota accuracy, provider units, webhook delivery, 429 rates, and voice reconnects through at least one normal usage window. Close a finding only with recorded evidence; leave missing live validation open.

## Verification commands to prepare for the next session

These commands record the original planning baseline. Use `scripts/security-checks.py` to reproduce the remediated branch; do not run application tests against host credentials. They were not run while originally creating this plan. Run them only inside the sandbox from Task 0, using locally available dependencies, a clean safe environment, and scratch-only state. Verify the interpreter exists before using the repository's documented virtualenv path.

From the repository root, the backend baseline command is:

```bash
backend/.venv/bin/python -m pytest -q -c backend/pytest.ini backend/tests
```

Set `PYTHON_DOTENV_DISABLED=1`, dummy service credentials, `NVIDIA_TIMEOUT=0.1`, and scratch-local `WHATSAPP_DB_PATH`/`BMO_STATE_DIR` in that sandbox. Ordinary unit suites may use `RATELIMIT_ENABLED=0`; dedicated rate-limit tests must enable it. Provider HTTP/WebSocket/JWKS calls must be stubbed before application import. Do not inherit real credentials from the host environment.

Frontend suite, using the existing package script:

```bash
npm --prefix frontend run test:run
```

Real-database permission checks, after applying the forward migrations to the isolated fixture:

```bash
psql -X --no-psqlrc --set=ON_ERROR_STOP=1 --file=backend/tests/security_rls.sql
```

Provide connection details only for the isolated dummy database through its safe environment. The proposed SQL test file must create/use fixtures transactionally and roll them back. Run the proposed reservation, Redis, and edge suites with their documented local harnesses after those files are created; record exact commands in the rollout runbook. Do not invent a passing result for tests that do not yet exist.

## Rollback and operational safeguards

- Share access: roll back to a compatible gateway/frontend build, not to a public table policy. A previously issued attachment URL may remain valid until expiry; do not promise immediate recall of copied content.
- Usage accounting: keep restrictive write grants and nonnegative constraints. If accounting is broken, temporarily disable new expensive work with a clear 503 instead of reporting zero usage. Preserve reservations/ledger evidence for reconciliation.
- Redis: restore a healthy shared backend or pause protected work; do not fall back silently to per-process counters. Keep rollback credentials secret.
- Voice: retain the secure ticket endpoint and compatible frontend build. Pause voice if ticket/budget enforcement is unavailable; do not permanently restore login JWTs in URLs.
- Edge: keep the previous hostname path available only during the planned transition. Use controlled dual-secret rotation and verified upstream health. Avoid restoring an unrestricted public origin as a routine rollback.
- Turnstile: document a short, explicit operator rollback of the new challenge/clearance enforcement if it blocks legitimate traffic. Authentication, application quotas, edge-origin authentication, and request limits stay enforced.
- Migrations: back up schema/configuration before approved production changes, apply transactionally where supported, and prefer forward repairs. Do not run destructive `_down.sql` files or delete user data as a routine rollback.
- Spending: enforce resource-unit ceilings locally and provider-side limits where available. Reconcile delayed provider reporting; an application estimate does not guarantee an exact invoice maximum.

## Definition of done

- [ ] Every finding has either verified remediation or an explicitly documented evidence blocker; no unverified production claim is marked complete.
- [ ] Anonymous/client roles cannot enumerate shares or mutate usage; valid links and owner operations still work.
- [ ] All billable operations use authoritative admission, and unavailable accounting never becomes free quota.
- [ ] Request limits and voice tickets/concurrency work across workers and survive worker replacement correctly.
- [ ] Voice is budgeted, bounded, and uses single-use tickets instead of login JWT URLs.
- [ ] The deployed API traverses Cloudflare, Render origin bypass is blocked, and SSE/WebSocket/upload/webhook checks pass.
- [ ] Turnstile validation is enforced at the selected backend boundary and its exceptions are narrow and documented.
- [ ] Sensitive logging is removed, operational alerts/ownership exist, and production administrator/token checks are recorded.
- [ ] Full regression results, real SQL/Redis evidence, live rollout evidence, and tested rollback procedures are recorded without secrets.

## Primary references

- [Supabase: RLS, grants, and policy testing](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Flask-Limiter: storage configuration and per-process memory limitations](https://flask-limiter.readthedocs.io/en/stable/configuration.html)
- [Cloudflare: rate limiting rules and plan availability](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Cloudflare: managed rules and plan availability](https://developers.cloudflare.com/waf/managed-rules/)
- [Cloudflare: protecting the origin](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/)
- [Cloudflare: mandatory Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

These references were consulted during the source review. Recheck version-sensitive APIs, product entitlements, and provider limits when implementing.

## Original backend-plan handoff — 2026-11-02

**Plan created; implementation has not started.** No production resource was probed or changed, no migrations were applied, and no application tests were run while writing this document. Resume at Task 0 only when the user asks to continue.

---

## Frontend audit and remediation addendum — 2026-11-03

**Scope:** The user requested a deeper frontend review, an inventory of installed Impeccable/taste/Claude skills, and frontend findings in this same file. The backend plan above is preserved. This addendum authorizes investigation and documentation only; it does not mark any application fix as implemented or authorize cloud changes.

**Product interpretation:** Bimo's chat, projects, settings, and sharing screens are task-oriented product interfaces. Preserve their existing identity while fixing reliability, accessibility, feedback, and device behavior. Evaluate the public landing page separately. A marketing skill's preference for a font, card shape, or animation is not evidence of a frontend bug.

### Installed skill inventory and selection

Inspected names/descriptions across these actual filesystem roots, excluding dependency internals such as `.venv`, `node_modules`, and `.git`:

| Root | Discovered `SKILL.md` files | Interpretation |
| --- | ---: | --- |
| `/home/saim/.agents/skills` | 25 | Includes taste, redesign, image-direction, minimalism, and engineering skills. |
| `/home/saim/.codex/skills` | 36 | Includes UI/UX Pro Max, SEO, and system skills; some extension definitions are duplicates. |
| `/home/saim/.claude/skills` | 1 | The standalone skill here is `use-tinyfish`. |
| `/home/saim/.claude/plugins` | 284 | Cached versions and bundled copies: 142 named skills, 191 distinct file contents. These are not 284 independently enabled capabilities. |
| `/home/saim/.codex/plugins/cache` | 108 | Includes the installed Impeccable plugin and other curated plugin workflows. |

The inventory covers 454 discovered files, not a claim that every body was executed or every cached plugin is active. Applicable guidance was read in depth or by relevant sections; unrelated skills were screened through their metadata. `/home/saim/.taste-skill` exists as a directory but contains no `SKILL.md`. Claude's frontend skill was found in its plugin cache, not in that empty directory.

Use these shorthand roots in the table below: **A** = `/home/saim/.agents/skills`; **C** = `/home/saim/.codex/skills`; **P** = `/home/saim/.codex/plugins/cache/openai-curated-remote`; **K** = `/home/saim/.claude/plugins/cache`.

| Skill / actual location | Fit for Bimo and how to use it |
| --- | --- |
| **Impeccable** — `P/impeccable/4.3.1/skills/impeccable/SKILL.md` | Primary audit framework. Its context loader, audit guidance, and mechanical detector were used. Prefer `harden` for recovery/state defects, `adapt` for verified device problems, `optimize` after profiling, then `polish` after correctness. No UI editing command was executed. |
| **design-taste-frontend** — `A/design-taste-frontend/SKILL.md` | Relevant sections reviewed. Stronger fit for the landing page and preserving a deliberate visual system. Its own scope excludes dashboards and multi-step product UI, so it does not dictate chat architecture. |
| **Claude frontend-design** — `K/claude-plugins-official/frontend-design/1.1.1/skills/frontend-design/SKILL.md` | Loaded and reviewed. Useful for intentional hierarchy, plain copy, restraint, focus visibility, and avoiding CSS specificity conflicts. This loads installed skill guidance; it does not invoke the Claude CLI or spend a second model API budget. |
| **UI/UX Pro Max** — `C/ui-ux-pro-max/SKILL.md` | Reviewed and queried for keyboard/focus/error guidance. Its generic design-system search suggested a pricing-focused landing page, which does not fit the chat workspace and was rejected. No generated design system was persisted. |
| **redesign-existing-projects** — `A/redesign-existing-projects/SKILL.md` | Useful audit checklist for missing states, semantics, responsive layouts, and keeping the current stack. Do not apply its aesthetic bans, invented content, or redesign instructions as automatic bug fixes. |
| **Claude design-system** — `K/ui-ux-pro-max-skill/ui-ux-pro-max/2.13.0/.claude/skills/design-system/SKILL.md` | Reviewed. Useful later for semantic/component tokens and state specifications, especially contrast. Existing CSS variables can be improved without adding another token generator or slide system. |
| **Claude ui-styling** — sibling `ui-styling/SKILL.md` in the same Claude bundle | Reviewed. Its accessible component concepts help, but its React/Radix/Tailwind installation recipe does not match Bimo's vanilla JS/CSS. No framework migration is proposed. |
| **design-taste-frontend-v1** — `A/design-taste-frontend-v1/SKILL.md` | Reviewed for applicability. Legacy compatibility reference; use the current taste skill unless a project explicitly depends on v1. Do not stack both rule sets. |
| **high-end-visual-design** — `A/high-end-visual-design/SKILL.md` | Reviewed. Keep useful responsive/performance guardrails; its mandatory glass, nested cards, font bans, and cinematic motion are not universal usability requirements. |
| **gpt-taste** — `A/gpt-taste/SKILL.md` | Reviewed. Its randomized compositions and GSAP/AIDA page structure suit exploratory marketing work, not this reliability audit or chat task flows. |
| **stitch-design-taste** — `A/stitch-design-taste/SKILL.md` | Reviewed. Useful only for a future Google Stitch/design-document task. Its perpetual motion prescription conflicts with calm operation and reduced-motion needs here. |
| **minimalist-ui** — `A/minimalist-ui/SKILL.md` | Reviewed as an optional visual reference close to a restrained document workspace; it is not a replacement for product evidence or an instruction to redesign. |
| **industrial-brutalist-ui** — `A/industrial-brutalist-ui/SKILL.md` | Reviewed for fit. Its tactical/terminal identity would be a new visual direction and is not appropriate for fixing the current product. |
| **image-to-code**, **imagegen-frontend-web**, **imagegen-frontend-mobile**, **brandkit** | Screened; image-direction sections reviewed where relevant. Useful for an explicitly requested redesign or new visual assets, not for discovering state/keyboard failures. No images were generated. |
| **SEO visual/performance/technical skills** under `C` | Potential follow-up for public-page rendering, performance, and search discoverability. A full SEO crawl, backlink analysis, or paid data collection is outside this frontend task. |
| **Figma/Adobe/Canva/Sites design workflows** in plugin caches | Relevant to requested design artifacts or their own hosted projects, not necessary for this local frontend audit. No external documents or sites were created. |
| **React best practices / microfrontends**, engineering, backend, security, content, and other cached skills | Metadata screened. Framework-specific refactors, broad architecture rewrites, backend re-audits, and unrelated content workflows do not help resolve the frontend failures below. Reuse the existing test/verification/planning workflows instead. |

**Conflict resolution:** Product behavior and accessibility come first. Keep the current vanilla stack and brand; do not combine mutually exclusive instructions such as compulsory heavy motion versus reduced motion, flat surfaces versus mandatory nested glass cards, or preserving the existing interface versus randomized layouts. Differences in font taste are not reported as defects.

### Audit method, verification, and limits

- Inspected real routing, auth transitions, API streaming, composer submission/cancellation, sharing, project actions, settings usage feedback, and CSS color/dialog rules.
- Ran Impeccable context once against `frontend`. It found no `PRODUCT.md` or `DESIGN.md`; its scoped-audit path permits using the existing implementation directly. This is not evidence that the existing interface lacks a visual identity.
- Ran Impeccable's detector once against `frontend/js` and `frontend/css/styles.css`. It returned warning-level heuristic matches, including bounce easing, layout-property transitions, gradient text, and side borders. These warnings are not treated as verified defects by themselves. In particular, border-drawn shapes and loading treatments must be judged in context rather than relabeled as broken cards.
- Executed real frontend modules with JSDOM and the existing `moduleLoader`/chat-page fixture approach inside Bubblewrap: external networking disabled, environment cleared and allowlisted, frontend source mounted read-only, only assigned scratch writable, and bounded time/CPU/address space/processes/files/output. Dependencies and providers were stubbed; dummy identities and strings were used.
- Ten targeted reproduction checks demonstrated the routing, auth-transition, failed-send, cancellation, stream-EOF, publication, keyboard, and focus problems detailed below. The route race check used controlled deferred route handlers; the chat checks used the actual page/composer/stream code with fake network boundaries.
- Browser rendering was attempted with installed Playwright/Chrome inside the restricted environment. The first attempt found a Python interpreter/package mismatch; after correcting that, Chrome terminated with `SIGTRAP` during sandboxed startup. No screenshots, real viewport measurements, Lighthouse metrics, or screen-reader results were obtained. Browser/device conclusions remain open; the audit does not claim a completed visual critique or WCAG certification.
- Two independent review agents were attempted. Both stopped at the account/session usage limit before delivering complete reviews. Their partial suspicions were not accepted as final findings; the completed evidence and document synthesis are from the parent review.
- The existing frontend suite was also run in the sandbox. The initial harness omitted root `vercel.json`, causing a fixture file-not-found failure; the configuration was then mounted read-only and the suite rerun. Final result: **46 tests passed, 0 failed, 0 skipped**, using `node --experimental-vm-modules --test --test-reporter=tap tests/*.test.mjs` with the sandbox's Node heap cap. This green baseline does not cover the ten targeted failing-behavior checks above. Backend code/tests and deployed endpoints were not exercised in this addendum.

**Evidence labels:** **Reproduced** means a bounded module/DOM fixture demonstrated the behavior. **Source-confirmed** means the implementation and affected path are visible, with browser/live checks still needed where stated. Priorities are frontend repair priorities: P1 causes significant difficulty, data loss, unintended publication, or an accessibility blocker; P2 has a workaround or affects reliability/feedback. No P0 whole-application outage is claimed.

### Frontend findings

#### FE-01 — P1: Unknown URLs throw instead of displaying the 404 screen

**Evidence:** Reproduced. `frontend/js/router.js:41–48` compiles every pattern as a regular expression. `findRoute` also passes the registered `*` pattern through it; `frontend/js/main.js:52` registers that wildcard.

**Trigger/result:** Visit `#/does-not-exist`. `dispatch()` throws `SyntaxError: Invalid regular expression: /^*$/: Nothing to repeat`; the fallback handler is never called. The existing page can remain visible under the wrong URL, or initial navigation can remain blank.

**Fix:** Handle the wildcard before normal pattern compilation, correctly escape literal route characters, and keep the 404 fallback reachable. Catch/report route mounting failures through a recoverable UI boundary.

**Acceptance:** Unknown hashes, malformed route segments, trailing slashes, and query strings must produce the intended route or one 404 render, without an unhandled rejection.

#### FE-02 — P1: Concurrent navigation can render an older route and lose cleanup

**Evidence:** Reproduced with controlled deferred handlers. `frontend/js/router.js:62–80` has one mutable cleanup reference and no dispatch generation or cancellation. Real handlers such as `renderProjects()` and `renderChat()` are asynchronous.

**Trigger/result:** Start a slow route, navigate to a fast route, then resolve the slow handler. Observed order: `render-fast`, `render-slow`; navigating again runs `cleanup-slow` while the fast handler's cleanup was lost.

**Fix:** Define a latest-navigation ownership contract across the router and async page mounts. Check ownership before mutating shared shell DOM, cancel stale loads, dispose stale handlers, clear cleanup before invoking it, and handle mount exceptions. A check only after `await handler()` cannot undo DOM writes already performed by a stale handler.

**Acceptance:** Resolve two navigations in both orders; only the newest route may own the shell, its cleanup must run exactly once, and obsolete data must not overwrite the current page.

#### FE-03 — P1: Sign-out/session changes do not re-run route guards after boot

**Evidence:** Reproduced at the real `main.js` auth listener with a stubbed auth source. `frontend/js/main.js:63–74` redispatches only when bootstrapping changes to false. `frontend/js/auth.js:155–156` can subsequently emit a cleared or changed session.

**Trigger/result:** After authenticated boot, emit a sign-out event as another tab or session-refresh failure would. Observed dispatch count stays `1 → 1`. The current private view is not unmounted by this handler. The explicit sidebar Logout button does navigate, so this finding concerns other auth transitions; it is not a claim of backend authorization bypass.

**Fix:** Re-run protected-route handling on meaningful identity changes/session loss, abort page-owned work, clear sensitive cached view state, and avoid remounting everything on ordinary token refresh.

**Acceptance:** Cross-tab sign-out, refresh failure, and A-to-B account changes clear/remount the correct view. Token renewal for the same user preserves the draft and does not duplicate listeners.

#### FE-04 — P1: A failed send loses the user's draft, attachments, and selected skills

**Evidence:** Reproduced with the actual composer and page. `frontend/js/chat/composer.js:465–480` clears the textarea and attachment state without awaiting submission; `frontend/js/pages/chat.js:800–801` clears skill selection, and `:917–920` removes the optimistic message on a non-abort failure.

**Trigger/result:** Send a draft with an attachment and return a network failure before persistence. The fixture observed `draft=""`, zero pending attachments, and zero visible messages; only an error toast remained.

**Fix:** Model a pending turn explicitly. Preserve a recoverable draft/attachments/skills until acceptance is known, or keep a failed message with Retry/Edit. Distinguish failure before submission from failure after server acceptance to avoid duplicate sends. Do not overwrite a newer draft when restoring an older one.

**Acceptance:** Offline, 401 refresh failure, 413, 429, and provider errors preserve a usable recovery path. Retry reuses the intended attachments/skills and does not duplicate a persisted message.

#### FE-05 — P1: Stop during link reading does not stop the subsequent chat request

**Evidence:** Reproduced. `frontend/js/pages/chat.js:856–899` awaits scraping before `executeStream()` creates its controller. Scrapes receive no signal, while the Stop callback at `:587` only calls `streamHandler.cancel()`.

**Trigger/result:** Submit a URL, hold its scrape response, press Stop, then resolve the scrape. The real page starts one chat request after Stop. The same missing turn ownership needs guarding during navigation/unmount.

**Fix:** Allocate a turn-level AbortController before preprocessing; pass its signal to scrapes and generation, check cancellation/route ownership after each await, and prevent an abandoned turn from starting generation. Preserve already received output when stopping an active stream.

**Acceptance:** Stop/unmount during one or several scrapes produces zero later generation requests and no stale DOM writes. Stop during streaming still cancels the correct request once.

#### FE-06 — P1: Premature stream EOF is silently accepted and can discard the partial answer

**Evidence:** Reproduced. `frontend/js/api.js:344–409` returns on reader EOF without requiring a completion or assistant-message event. `frontend/js/chat/stream-handler.js:276–277` clears stream state in `finally`; the page stores the final assistant turn only through its assistant-message handler.

**Trigger/result:** Deliver a valid token event containing a partial answer and close the reader before terminal events. Observed: token received, `onComplete=0`, `onError=0`, return value `null`. Cleanup can remove the displayed partial content instead of reporting an interrupted response.

**Fix:** Track protocol completion and persistence acknowledgement separately. Preserve partial text/reasoning on interruption, expose an actionable interrupted state, cancel/release the reader on terminal errors, and reconcile saved conversations before retrying. Do not require a saved message for legitimate incognito responses; pin both protocols with tests.

**Acceptance:** Test EOF before any event, after tokens, after completion but before persistence, normal saved completion, incognito completion, reader errors, and user cancellation. An incomplete response must never be silently presented as successful.

#### FE-07 — P1: Dismissing the Share dialog can still publish the conversation

**Evidence:** Reproduced. `frontend/js/components/share-modal.js:174–196` auto-creates a snapshot after awaiting metadata. Its close path does not invalidate or cancel that continuation.

**Trigger/result:** Open Share, dismiss it while metadata is loading, then resolve metadata with `{shared:false}`. The fixture observed one publication call after dismissal. Opening the dialog also publishes automatically without a separate Create link action.

**Fix:** Make initial publication an explicit user action after the visibility explanation. Bind every asynchronous operation to the active dialog instance; dismissing an unconfirmed dialog must prevent its pending metadata response from starting a mutation. If an already confirmed publication is in flight, accurately surface its result rather than pretending cancellation revoked it.

**Acceptance:** Open-and-dismiss causes no POST. A valid explicit Create action publishes once. Close/reopen, navigation, slow responses, Update, and Revoke cannot mutate or close the wrong dialog instance.

#### FE-08 — P1: Modal dialogs lack a complete accessible focus and naming contract

**Evidence:** Source-confirmed. `frontend/js/components/share-modal.js:149–168` sets `role="dialog"`/`aria-modal` without an accessible name or initial focus. Its key handler only handles Escape. Project dialogs at `frontend/js/pages/projects.js:485`, `:843`, and `:939` have similar gaps. `confirm-modal.js` does correctly assign its referenced title ID and set initial focus; it still has no focus containment/restoration or background inertness.

**Impact:** Keyboard focus can remain behind an apparently modal overlay or leave it, and assistive technology may encounter unnamed dialogs. Screen-reader/browser validation is pending; the source omissions are not inferred from an automated score.

**Fix:** Use a small shared native-dialog/focus-lifecycle approach suited to vanilla JS: unique title association, deliberate initial focus, Tab/Shift+Tab containment, inert background, Escape handling, scroll-lock cleanup, and return focus to a connected invoker. Choose the least destructive initial action for dangerous confirmations.

**Acceptance:** Keyboard-only tests cover open, forward/reverse wrap, Escape, nested/replaced overlays, dismissal during async work, and focus restoration. Verify names and reading order with an accessibility tree and a screen reader. See the W3C modal dialog reference below.

#### FE-09 — P1: Project upload and existing-chat actions cannot be reached by keyboard

**Evidence:** Reproduced DOM semantics plus source. `frontend/js/pages/projects.js:606–630` uses a click-only upload `div` containing a `display:none` file input. `:798–809` uses a click-only `li` for each existing project chat. Both had `tabIndex=-1` in the fixture, without an alternative reachable control for those actions.

**Fix:** Provide a visible native upload button and a properly associated file input; render chat destinations as real anchors. Preserve drag/drop as an additional input method. Avoid making whole list containers pretend to be buttons with nested interactive children.

**Acceptance:** A keyboard-only user can select a knowledge file and open every project chat with visible focus. Upload is operable without a pointer or drag/drop. Relevant standard: WCAG 2.1.1 Keyboard.

#### FE-10 — P1: Enter on Remove file opens Preview instead

**Evidence:** Reproduced. The file-row keydown handler at `frontend/js/pages/projects.js:650–654` handles Enter/Space from descendants and calls `preventDefault()`. The nested Remove button stops click propagation only at `:673–674`.

**Trigger/result:** Focus Remove and press Enter. The fixture observed `preview=1`, `confirmation=0`, and the key event default prevented. The parent intercepts the child action and suppresses native activation.

**Fix:** Prefer separate native Preview and Remove controls. If retaining the row handler temporarily, act only when the row itself is the event target and preserve the nested button's native keyboard behavior.

**Acceptance:** Enter and Space on Remove open only its confirmation; the Preview action opens only the preview. Clicking or pressing keys on nested controls must never trigger both actions.

#### FE-11 — P1: Delayed composer autofocus steals focus from other controls

**Evidence:** Reproduced. `frontend/js/pages/chat.js:613–630` focuses the composer repeatedly through 1,000 ms without checking user intent/current focus. `:643–646` also refocuses on window/page events.

**Trigger/result:** Mount chat, focus a different field immediately, and let the 50 ms callback execute. The fixture observed focus returning to the composer. This also conflicts with opening a dialog quickly or interacting during startup. Mobile keyboard behavior still needs a real device check.

**Fix:** Focus once when appropriate, condition it on route ownership and no intervening user focus, track/cancel pending callbacks on unmount, and suspend composer autofocus while a dialog, menu, or other editable control owns focus. Respect touch/mobile intent.

**Acceptance:** Opening a modal or focusing another field immediately after navigation remains stable after all startup timers. Returning to a tab does not steal active dialog focus or unexpectedly open the mobile keyboard.

#### FE-12 — P1: Primary-button text has insufficient contrast

**Evidence:** Source-confirmed with a relative-luminance calculation. `frontend/css/styles.css:35–38` and `:126–129` pair coral `#d97757` with white text. `.btn.primary` at `:801–803` and `.confirm-modal-btn.primary` at `:10945–10947` use that pair; the latter is 14 px, weight 500.

**Result:** White on coral measures **3.12:1**, below the **4.5:1** minimum for ordinary small text. The defined danger-button pair white/`#e24b4a` measures **3.93:1** and needs the same state review. This is a calculation for the specified styles; full computed-style/browser coverage remains pending.

**Fix:** Keep coral as the brand accent but introduce accessible foreground/background tokens for text-bearing controls. Verify normal, hover, active, focus, disabled, and both themes. Do not force a site-wide font or palette replacement.

**Acceptance:** Every enabled small-text button meets 4.5:1 in its actual computed state. Review non-text focus/control contrast separately; disabled/decorative content has different requirements.

#### FE-13 — P2: Usage settings can stay stale and disappear on a transient failure

**Evidence:** Source-confirmed. `frontend/js/pages/settings.js:66–74` reuses `getShellState().usage` without freshness checks and removes the whole panel when its initial request fails. `loadUsage()` exists in `app-shell.js:72–82`, but no caller was found in the indexed frontend.

**Trigger/result:** View usage, consume more allowance, then revisit settings without tearing down the shell; the cached percentage/reset text may remain unchanged. On a temporary usage-request error, the user loses the panel and its recovery path.

**Fix:** Revalidate on settings entry and relevant completed turns, bind results to the current identity, and show loading/stale/unavailable states with Retry. Do not present stale data as current or infer zero consumption. Coordinate the response handling with backend Task 3's explicit unavailable state.

**Acceptance:** Revisit after a completed turn, cross a reset boundary, switch users, and simulate a 503. The UI shows fresh or explicitly unavailable data, preserves panel context, and offers a working retry.

### Items requiring browser/device evidence before becoming findings

- Test 320/375/390/768/1024/1440 px widths, light/dark/system themes, 200% zoom/reflow, long names/URLs/code, RTL text, and iOS/Android keyboard/viewport changes. Source breakpoints alone do not establish that a screen works or breaks.
- Inspect the mobile document modal's `100vh` sizing at `styles.css:11832–11834` against browser chrome and the keyboard. Treat clipping as unconfirmed until a device/browser reproduction exists.
- Profile layout-property transitions flagged by the detector; measure before calling them jank. Review persistent blur effects, long chat memory, and requestAnimationFrame work with a representative fixture.
- Review startup availability: `supabaseClient.js:5` statically imports a remote SDK on the main module graph. Test a blocked/slow SDK request and confirm a recoverable boot error; do not report an unmeasured CDN outage as an observed production incident.
- Verify reduced-motion alternatives. The global 0.001 ms rule at `styles.css:305–312` deserves inspection, but several components have dedicated reduced-motion behavior; do not blanket-report all motion as inaccessible.
- Check actual mobile target rectangles and spacing. Prefer comfortably sized 44 px controls where practical, but WCAG 2.2 AA's minimum is 24 by 24 CSS px with exceptions, not an unconditional 44 px requirement. The source-defined Share close control is not automatically an AA failure merely for being below 44 px.
- Verify chat answer/status announcements with a screen reader before asserting silence or excessive announcements. Existing toast live regions and voice status announcements are positive evidence to preserve.

### Positive findings and rejected false positives

- The frontend already has a consistent CSS token foundation and dedicated light/dark values; preserve it while fixing contrast.
- Markdown rendering uses DOMPurify and an escaped plain-text fallback when optional libraries fail. A failed syntax-highlighting import is not automatically XSS.
- Incognito history, attachment ownership refresh checks, stream rendering, and cancellation have existing regression tests. Add the uncovered cases rather than discarding that work.
- The toast container has `aria-live="polite"`; voice status and image-generation states also include announcements in their own paths.
- Confirm/prompt dialogs assign the `aria-labelledby` target ID dynamically. The initial suspicion of a missing confirm title ID was rejected after reading the full function.
- The birthday onboarding control includes a native labeled date input; its visual wheel alone does not prove a keyboard blocker.
- The existing sidebar Logout action navigates after sign-out. FE-03 is scoped to other auth changes, not that explicit button.
- Neither a chosen serif font, the existing coral accent, nor a CSS detector's word “slop” establishes a defect. No fabricated benchmark, aesthetic score, or overall WCAG pass/fail is assigned.

### Frontend implementation plan for the next authorized session

All files listed as new below are proposed. No frontend test or source file was added during this audit; temporary reproduction harnesses remain outside the repository and are removed after documenting the results.

#### F-Task 0: Preserve a reproducible frontend baseline

**Files:** Existing `frontend/tests/modules.mjs`, `frontend/tests/chat-page.test.mjs`, `frontend/tests/regressions.test.mjs`; this document.

- [ ] Record the new implementation revision and verify no unrelated work is overwritten.
- [ ] Convert the isolated reproduction cases into permanent regression tests with the existing zero-build ES-module/JSDOM harness; verify each case fails for the expected behavioral reason first.
- [ ] Keep a real-browser fixture plan for focus/tab order, mobile viewports, computed contrast, and transport behavior. Do not replace browser evidence with JSDOM geometry or live production accounts.

#### F-Task 1: Repair navigation ownership and auth transitions — FE-01, FE-02, FE-03

**Modify:** `frontend/js/router.js`, `frontend/js/main.js`, relevant page mount/cleanup boundaries and `frontend/js/app-shell.js`.

**Create:** Proposed `frontend/tests/router.test.mjs`; extend `frontend/tests/regressions.test.mjs`.

- [ ] Add wildcard, rejected-handler, reversed-resolution-order, repeated navigation, and cleanup-once tests.
- [ ] Introduce a minimal dispatch generation/AbortSignal contract, thread it through async page work before shared DOM writes, and preserve URL/history behavior.
- [ ] Add auth listener tests distinguishing boot, token renewal, sign-out, failed refresh, and identity replacement. Clear old-user shell data/work without deleting a same-user draft on token renewal.
- [ ] Verify direct loads of chat, projects, settings, shares, and unknown hashes in both logged-out and authenticated states. Review cache-busted module imports so the correct revised router is loaded consistently.

#### F-Task 2: Preserve user work and make a turn cancellable end to end — FE-04, FE-05, FE-06

**Modify:** `frontend/js/chat/composer.js`, `frontend/js/pages/chat.js`, `frontend/js/chat/stream-handler.js`, `frontend/js/api.js`.

**Tests:** Extend `frontend/tests/chat-page.test.mjs`, `frontend/tests/attachments.test.mjs`, `frontend/tests/voice.test.mjs`, and `frontend/tests/regressions.test.mjs`.

- [ ] Define one turn owner and signal spanning preprocessing, scrape, generation, and teardown; retain existing voice callbacks and cancellation semantics.
- [ ] Add failed-send state that retains text/files/skills, knows whether a turn was accepted, and cannot overwrite a newer draft. Provide visible Retry/Edit and an accessible error message.
- [ ] Track stream completion separately from persistence acknowledgement; preserve interrupted partial output and reconcile saved turns before retrying. Test saved and incognito protocols separately.
- [ ] Verify Stop before fetch, during each scrape, during streaming, and immediately after completion; verify navigating away prevents late generation and stale view updates.

#### F-Task 3: Make sharing deliberate and dialogs correctly modal — FE-07, FE-08, FE-11

**Modify:** `frontend/js/components/share-modal.js`, `frontend/js/components/confirm-modal.js`, relevant project dialog functions, `frontend/js/pages/chat.js`, and focused dialog CSS.

**Create:** Proposed `frontend/tests/dialogs.test.mjs`; extend proposed `frontend/tests/security.test.mjs` and existing chat-page tests. Create a small shared dialog helper only if actual reuse warrants it; prefer native platform behavior where compatible.

- [ ] Add an explicit Create public link action while preserving existing link update/revoke behavior and the backend plan's removal of direct table fallbacks.
- [ ] Add per-dialog async ownership and a complete naming/focus/cleanup contract. Closing one instance must not close or update a newer instance.
- [ ] Remove repeated unconditional composer focus calls and cancel pending focus work. Test interaction with both dialog fields and ordinary controls.
- [ ] Run real-browser Tab/Shift+Tab/Escape/focus-restoration checks before declaring this task verified. Coordinate FE-07 changes with backend Task 1 instead of making competing edits.

#### F-Task 4: Restore native keyboard behavior in Projects — FE-09, FE-10

**Modify:** `frontend/js/pages/projects.js` and narrowly related selectors in `frontend/css/styles.css`.

**Create:** Proposed `frontend/tests/projects-accessibility.test.mjs`.

- [ ] Replace the click-only upload target with a reachable upload action; keep drop support and existing progress/error states.
- [ ] Use anchors for chat navigation and distinct native Preview/Remove controls for file actions. Preserve names, propagation, and visible focus.
- [ ] Test Enter/Space/click independently, including event bubbling from child controls and cancellation of the Remove confirmation.

#### F-Task 5: Fix contrast and honest usage feedback — FE-12, FE-13

**Modify:** `frontend/css/styles.css`, `frontend/js/pages/settings.js`, `frontend/js/app-shell.js` only where refresh ownership requires it.

**Tests:** Extend frontend regression tests and add focused computed-style/contrast browser cases.

- [ ] Establish accessible text-bearing control tokens for primary/danger states in both themes; preserve the existing brand identity and typography.
- [ ] Add explicit usage loading/fresh/stale/unavailable states and retry, invalidate by identity, and refresh after completed work or settings re-entry.
- [ ] Verify actual enabled-state contrast and background composition in-browser, plus usage refresh/reset/failure behavior. Do not treat a cached quota percentage or a passing token calculation as full UI verification.

#### F-Task 6: Complete the visual/device/performance evidence, then polish

**Files:** Only components/styles demonstrated to need changes; relevant existing tests and this checklist.

- [ ] Restore a bounded browser harness before taking screenshots. Capture desktop/mobile and light/dark variants in one planned batch, fix the verified issues together, and use at most one confirmation round as Impeccable recommends.
- [ ] Run the pending viewport/zoom/keyboard/RTL/long-content checks above, manual screen-reader checks, and representative performance profiling. Promote only reproduced/source-supported failures to new FE IDs.
- [ ] Use Impeccable `adapt`/`harden`/`optimize` for the verified categories, then `polish` last. Treat Claude/taste skills as contextual guidance; no random layout, paid image generation, or framework migration is required.
- [ ] Run the full frontend suite after the focused checks pass. Review the final diff for regressions, leaked content, lost drafts, duplicate listeners, unsafe fallbacks, and unnecessary dependencies. Update this document with exact evidence and remaining limits.

### Accessibility references consulted

- [W3C APG: modal dialogs, focus containment, naming, and restoration](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [WCAG 2.2: keyboard operation](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html)
- [WCAG 2.2: minimum text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [WCAG 2.2: minimum target size and exceptions](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

### Current handoff

**Frontend audit documented; implementation has not started.** The earlier backend plan remains open. Only `bugs.md` is intended to change in the repository. No cloud settings, production data, application source, or permanent test files were changed. Resume with the task corresponding to the user's next requested scope; do not automatically begin the backend plan because the calendar date changed.
