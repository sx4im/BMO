# Ponytail audit

Scope: repository-wide inventory/AST scan of 112 tracked Python/JavaScript source and test files, dependency manifests, and shared CSS; followed by source/caller checks for the findings below. Findings are supported by source/caller checks; line reductions are estimates. This audit proposes cleanup only and applies no unrelated changes.

delete: Retire unused birthday-wheel, role, theme-picker, and step-progress styles after the features-only release card replacement. Approximately 174 lines of obsolete selector blocks; preserve the shared card, feature, and action styles. [frontend/css/styles.css](../../frontend/css/styles.css)

shrink: Combine the two identical messageBubble configuration blocks in MessageFeed.render; construct once when a row is new or changed, then handle replacement/insertion. Approximately 14 lines. [frontend/js/chat/message-feed.js:330](../../frontend/js/chat/message-feed.js)

delete: Remove obsolete stream-done mask resets and streaming reduced-motion mask overrides. Neither a stream-done class nor a stream mask is produced; keep the unrelated masks used by other surfaces. Approximately 19 lines. [frontend/css/styles.css:9237](../../frontend/css/styles.css)

shrink: Remove the overridden mobile composer-voice SVG size declaration, or consolidate its sizing at the final rule. The later global declaration overrides both dimensions. Approximately 4 lines. [frontend/css/styles.css:8164](../../frontend/css/styles.css)

net: -211 lines, -0 deps possible.
