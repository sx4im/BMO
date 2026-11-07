# Security remediation verification — 2026-11-07

This is local engineering evidence, not a production security certificate. The reviewed base is `1b4b6d8a6a53ca8ca51397f89dad4d4a7a149d2e`; the implementation is on `fix/bimo-security-and-frontend`. Later commits contain the final review fixes and verification record. No deployment, production SQL, secret rotation or external notification was performed as part of local verification.

## Verified behavior

- Networkless backend/frontend/edge suites, actual Postgres role/operation/retention tests, concurrent independent SQL connections and fresh-process Redis counter/ticket tests. Final counts and clean-install status are recorded in `bugs.md`.
- Global concurrent scrape admission accepted5/10, the100k session accepted10/12 requests of10k, and the999999 weekly boundary accepted1/2 one-unit requests. Account deletion preserved anonymous global spend. SQL fixtures are disposable and must never run in production.
- Browser fixture:320/375/1440px chat in light/dark themes, Projects at320/375/640/1440, explicit sharing, dialog keyboard restoration/containment and computed primary/danger contrast>=4.5. A640 CSS-pixel viewport checks reflow equivalent to1280px at200%; actual browser zoom and assistive technology remain manual. External SDK/provider traffic was fake or blocked. This is not a real microphone, screen-reader, live OAuth or provider-billing check.
- Current nonignored source, including new source, was scanned with redacted Gitleaks8.30.1. Six initial matches were exact dummy tests or the public Supabase publishable key; narrow path-and-value allowlists retain default detection rules. Ignored environment files and Git history are outside that scan.
- OSV queried152 actual tested Python/npm/direct-CDN/vendor package versions with no matching advisories. This does not certify bundled native libraries, generated CDN dependency trees or future advisories. The query script fails on lookup failure or incomplete metadata. A clean fresh-install/remote-CI result is recorded separately when available; the152-version result above is specifically the actually tested existing environment plus patched overlay.

## Independent review and fix pass

A fresh read-only `gpt-6-astra` whole-branch review of the implementation found no confirmed Critical finding, four Important findings and no deferred Minor findings. All four were accepted:

| Finding | Regression and resulting behavior |
| --- | --- |
| Incognito omitted from human verification | Valid `/chat/incognito` requests require backend clearance; the client obtains it. Missing/forged clearance is rejected before provider work. |
| Admission failures converted to completed busy answers | Actual model-boundary429/503/409 failures, before and after partial output, propagate as SSE errors without a false complete event. |
| Failed auth deletion resets active usage | Real content-cleanup code preserves usage; failed auth deletion returns503, retains the active allowance and denies a subsequent over-limit paid request. Successful auth deletion retains FK cleanup. |
| Voice deadline includes human interaction | Human verification can exceed10s and still connect. A separate10s ticket transport timeout starts after verification; closing voice still cancels outstanding work. |

These regressions were observed failing before the corresponding fixes, then included in the full-suite confirmation. One model-denial fixture initially selected an unconfigured alternative provider; it was corrected to the real native SDK/admission path and all six intended denial cases were observed RED before restoring the fix. No second reviewer pass substitutes for regression evidence.

## Decisions and costs

These are the implementation rulings carried from the execution ledger. Account changes and staging evidence are coordinated privately outside version control.

| Decision | Reason / cost if wrong |
| --- | --- |
| Dedicated fix branch in the existing shared checkout | Preserves installed tooling and requested workspace; concurrent editors would need coordination. |
| Gateway-only sharing during outages | Keeps private table access authoritative; sharing becomes unavailable while the gateway is down. |
|4096 default output cap,8192 maximum; UTF-8/framing reserve and no automatic SDK retries | Bounds every actual attempt; long answers may truncate sooner and large inputs may be conservatively denied/charged. |
| PCM-only transcription,2MB/60s bounds | Compressed bytes cannot prove duration; old compressed-audio callers must convert. First-party clients already do so. |
| Anonymous global counters survive account deletion | Prevents allowance reset without retaining user identity; uncertain deleted-account work may remain conservatively charged globally. |
| Docker rather than UID-wide process limits | The desktop UID exceeded the old process cap; reproduction now requires Docker and Linux tooling. |
| Lazy provider voice connection; two/user,eight/global,15min session,60s idle; rolling24h per-user resource windows | Preserves bounded server capacity; first audio can incur connection latency and midnight does not instantly restore per-user allowance. |
| No invented gateway hostname or origin fallback | Account/zone ownership was unavailable; publishing blank/invalid public configuration makes the API unavailable until the required deployment configuration is verified. |
| One cohesive local implementation commit | Keeps coupled protocol/configuration changes together; rollback/cherry-pick granularity is coarser than per-task commits. |
| Live account/device/provider checks stay owner-operated | Those connectors/evidence were unavailable; production can remain misconfigured until the owner validates it. Remote Actions success is also a separate record. |
| Bounded best-effort WhatsApp background delivery | No new durable queue was introduced; a worker crash can require the user to resend. Admission remains mandatory. |
| Upstream sanitizer/native certification remains outside this audit | Provenance/integration and matching advisory checks are the measured boundary; undiscovered upstream/native/CDN risks still require maintenance. |

## Deployment evidence boundary

Account configuration and release coordination are delegated through a private agent handoff outside version control. Live cloud, provider and device evidence remains separate from local verification.
