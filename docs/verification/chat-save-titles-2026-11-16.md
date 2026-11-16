# Save confirmation, conversation titles, and mobile actions — 2026-11-16

## Reproduced defects and changes

- A successful assistant write taking 2.2 seconds reproduced the reported save
  warning: the writer's two-second final deadline returned failure while the
  database operation was still running. Final confirmation now has a bounded
  30-second budget. Answer tokens and `complete` still stream before that wait;
  genuine write failures and an exhausted deadline still report unconfirmed saving.
  No insert retries or duplicate rows are introduced.
- Usage-recording failures could discard the acknowledgment for an already saved
  answer. Metering failures are now logged separately, preserving the saved row
  acknowledgment and once-per-turn usage attempt.
- Title generation inherited the chat provider's long timeout/retries, while the
  sidebar stopped refreshing after 4.5 seconds. Title requests now use an
  independent eight-second timeout with zero retries. First-turn title refreshes
  continue through 20 seconds and are cleared on title changes, manual rename,
  new chat, and unmount. Older list responses cannot replace a newer title.
- Generated titles use an owned, atomic comparison against the seed title so a
  background result cannot overwrite a manual rename.
- Only below 768px, action icons now have a 2px gap and 32×44px targets. Chromium
  measured 34px icon-center spacing at 390px touch (previously 52px), and unchanged
  35px desktop spacing at 1280px. See the adjacent JSON geometry evidence.

## Verification scope

Regression tests were observed failing before the fixes for slow successful
saving, usage failure hiding a saved acknowledgment, late title refresh, title
request budgets, rename protection, timer cleanup, and stale sidebar responses.
Full suites pass: **495 backend tests** (117 existing dependency/test-key
warnings) and **163 frontend tests**. `graft build`, `graft check`, and
`git diff --check` pass.

The first full backend run had 473 passing tests and 22 failures in the existing
skill-import/export tests because PyYAML was missing from the local virtualenv.
Installed the already declared `PyYAML==6.0.3` dependency and reran the full suite;
no requirement or application workaround was added.

The live database probe was read-only: requests succeeded, but the conversation
from the screenshot was not present in the configured project's response. One
read took 7.018 seconds, exceeding the previous save deadline, but this does not
prove the screenshot's specific production failure cause. No production writes,
provider accuracy, or deployment were exercised. Tests use isolated tenant-aware
storage and provider doubles; persistent database outages still require the real
service to recover. Background work is not a durable queue across process exits.
