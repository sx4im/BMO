# Customize

`#/app/customize` has two tabs: global Instructions and text-only Skills. It reuses Projects' persistent app shell, cards, authentication, API client and theme tokens. The composer and message feed stay mounted while skills are selected. The sidebar icon is an inline SVG with CSS motion and respects reduced motion.

## Deployment

1. Apply `backend/migrations/0009_customize.sql` after migrations 0001–0008, **before deploying the backend**. Chat now reads preferences on every turn. The migration is idempotent; `0009_customize_down.sql` is the destructive rollback.
2. Install `backend/requirements.txt`. PyYAML 6.0.3 is the one approved dependency addition; there are no new frontend dependencies.
3. Deploy backend and frontend together. Existing conversations default to no active skills.

RLS protects preferences, skills and references. The skill reference FK includes the owner. A database trigger also validates direct conversation writes. All gateway reads, updates, deletes and exports filter by `user_id`; invalid, missing, foreign or disabled skill IDs return the same 404. An invalid list, duplicates or more than three IDs returns 422.

## API

| Endpoint | Method | Body / result |
| --- | --- | --- |
| `/preferences` | GET / PUT | `{instructions}`; at most 4,000 characters, empty clears |
| `/skills` | GET / POST | Metadata list / create `{name, description, instructions}` |
| `/skills/<id>` | GET / PUT / DELETE | Full skill with reference files / update text / delete |
| `/skills/<id>/enabled` | PUT | `{enabled: boolean}` |
| `/skills/upload` | POST | Multipart `file`: a Markdown `.md` skill |
| `/skills/<id>/export` | GET | `SKILL.md`; older skills with references export a ZIP |
| `/chat`, `/chat/incognito` | POST | Optional `skill_ids`: at most three distinct enabled, owned UUIDs |

Skill names are 1–64 lowercase ASCII letters, numbers and single hyphens, without leading or trailing hyphens, and unique per user. Description is required (1–1,024 characters). Instructions may be empty and are limited to 20,000 characters. An update preserves imported references.

Saved chats retain `conversations.active_skills`; omitting `skill_ids` reuses them and sending `[]` clears them. Incognito callers send their selection each turn and no conversation is stored. User messages keep immutable `{id, name}` snapshots for historical chips, including branches and shares. Disabled or deleted skills are excluded when creating a branch; historical labels remain.

Prompt order is global instructions, base prompt and its explicit safety precedence, active skills with references, project instructions/knowledge, then conversation/study/voice instructions. All user-written fields use the shared delimiter escaping helper. Text, vision and document continuation batches receive this context.

## Imports

Upload a `.md` file (up to 128 KB) using the [Agent Skills format](https://agentskills.io/specification): YAML frontmatter with a required `name` and `description`, followed by Markdown instructions. For example:

```markdown
---
name: code-review
description: Review code for bugs and suggest focused fixes.
---
Explain the root cause and keep suggested changes small.
```

Only `yaml.safe_load` parses frontmatter. Missing/invalid metadata, binary content, NUL/control bytes and scripts are rejected. ZIPs and other extensions are rejected before parsing. The frontmatter limit is 16,384 characters and the instructions limit is 20,000 characters. Optional frontmatter fields do not grant tools or execute code.

The saved name and description come from frontmatter, regardless of the filename. UTF-8 BOMs, Windows line endings and trailing whitespace on frontmatter delimiters are accepted. The Markdown body is kept as the instructions. This metadata/body separation follows the Agent Skills specification and the published [Claude](https://support.claude.com/en/articles/12512180-use-skills-in-claude) and [OpenAI](https://learn.chatgpt.com/docs/build-skills) guidance.

Uploads show actual transfer progress, then an indeterminate “Checking skill…” state while the backend validates and saves. Validation errors appear in red below the Skills toolbar; failed edits and toggles show errors in the affected card or editor. Successful imports show the metadata name and a **Use in chat** link that opens a new chat with the skill selected. Enabled card titles offer the same shortcut. BIMO applies selected skills explicitly through these shortcuts or the `/` picker; enabling a skill makes it available for selection. Returning to an existing chat tab refreshes its skill catalog without rebuilding the composer.

Card descriptions stay on one line with an ellipsis; hovering reveals the full description. Editing, exporting and chat prompts retain the complete content.

Text-only skills export as `SKILL.md`, ready to reupload. Existing skills with previously imported reference files still retain those references in chat, editing and archive exports.

## Verification

```bash
PYTHON_DOTENV_DISABLED=1 NVIDIA_TIMEOUT=0.1 NVIDIA_MAX_RETRIES=0 RATELIMIT_ENABLED=0 \
  WHATSAPP_DB_PATH=/tmp/bimo-test-whatsapp.db BMO_STATE_DIR=/tmp/bimo-test-streams \
  backend/.venv/bin/python -m pytest -q -c backend/pytest.ini backend/tests
npm --prefix frontend run test:run
```

`backend/tests/customize_rls.sql` checks real Postgres tenant isolation and direct invocation constraints in an isolated test database with an `auth.uid()` harness. The migration was applied twice, rolled back twice and reapplied in Postgres 16; all checks passed. Browser upload checks used real Chrome, the actual local Flask upload/chat routes, an in-memory database and stubbed inference under the deployment CSP. They verified metadata naming, inline validation, one-line descriptions, chat preselection, full instructions in the assembled prompt and 24px sent-file icons; live Supabase and inference were not contacted.

## Manual test checklist

- Save, reload and clear Instructions; check the counter at 4,000 characters and its effect in a normal, project, incognito and voice chat.
- Write a skill; edit its prefilled fields, toggle it, export it, delete it and reimport its SKILL.md. Duplicate names must fail for the same user.
- Import a renamed .md file with valid frontmatter; confirm its card uses the metadata name and description. On a throttled connection, check transfer percentages and the checking state. Select **Use in chat**, send a message and confirm its skill chip and instructions apply.
- Try missing name/description, a script, binary, NUL-bearing file or ZIP; each must show a red inline error without a toast. Retry with a valid file. Check a late list response does not clear the feedback.
- Confirm long descriptions occupy one line in light/dark and mobile/desktop, and sent attachment icons are smaller than composer previews. Import in another tab and return to chat; the `/` picker should include the new skill.
- Type `/`, filter, navigate with arrows, select with Enter/Tab or touch, close with Esc, and remove chips. Check the three-skill limit, sent chips and follow-ups after reload; edit/retry/attachments/streaming must still work.
- Repeat in light/dark, desktop/mobile and reduced motion. Sign into a second account and confirm the first account’s instructions and skills are unavailable.
