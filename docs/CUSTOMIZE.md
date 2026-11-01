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
| `/skills/upload` | POST | Multipart `file`: `SKILL.md` or `.zip` |
| `/skills/<id>/export` | GET | ZIP containing `<name>/SKILL.md` and text references |
| `/chat`, `/chat/incognito` | POST | Optional `skill_ids`: at most three distinct enabled, owned UUIDs |

Skill names are 1–64 lowercase ASCII letters, numbers and single hyphens, without leading or trailing hyphens, and unique per user. Description is required (1–1,024 characters). Instructions may be empty and are limited to 20,000 characters. An update preserves imported references.

Saved chats retain `conversations.active_skills`; omitting `skill_ids` reuses them and sending `[]` clears them. Incognito callers send their selection each turn and no conversation is stored. User messages keep immutable `{id, name}` snapshots for historical chips, including branches and shares. Disabled or deleted skills are excluded when creating a branch; historical labels remain.

Prompt order is global instructions, base prompt and its explicit safety precedence, active skills with references, project instructions/knowledge, then conversation/study/voice instructions. All user-written fields use the shared delimiter escaping helper. Text, vision and document continuation batches receive this context.

## Imports

The [Agent Skills format](https://agentskills.io/specification) uses YAML frontmatter (`name`, `description`) followed by the Markdown instructions body. Optional frontmatter fields are not used to grant tools or run code. A ZIP may place `SKILL.md` at the root or inside one directory matching its declared name. All references must be inside that directory.

Only `yaml.safe_load` parses frontmatter. Imports are never extracted to disk or executed. Limits: 1 MB uploaded, 512 KB expanded, 64 ZIP entries / 32 files, 100:1 compression ratio, 128 KB for SKILL.md and 64 KB per reference. References must be UTF-8 `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.tsv`, `.rst`, `.toml`, `LICENSE` or `NOTICE` files. Unsafe paths, duplicate paths, NUL/control bytes, links, executable files, scripts, nested archives, binaries, encryption and unsupported compression are rejected with validation errors. Archives containing a `scripts/` directory are rejected.

## Verification

```bash
PYTHON_DOTENV_DISABLED=1 NVIDIA_TIMEOUT=0.1 NVIDIA_MAX_RETRIES=0 RATELIMIT_ENABLED=0 \
  WHATSAPP_DB_PATH=/tmp/bimo-test-whatsapp.db BMO_STATE_DIR=/tmp/bimo-test-streams \
  backend/.venv/bin/python -m pytest -q -c backend/pytest.ini backend/tests
npm --prefix frontend run test:run
```

`backend/tests/customize_rls.sql` checks real Postgres tenant isolation and direct invocation constraints in an isolated test database with an `auth.uid()` harness. The migration was applied twice, rolled back twice and reapplied in Postgres 16; all checks passed. Browser checks used real Chrome with local API fixtures and the deployment CSP; live Supabase and inference were not contacted.

## Manual test checklist

- Save, reload and clear Instructions; check the counter at 4,000 characters and its effect in a normal, project, incognito and voice chat.
- Write a skill; edit its prefilled fields, toggle it, export it, delete it and reimport its ZIP. Duplicate names must fail for the same user.
- Import SKILL.md and a ZIP with text references. Try a script, binary, NUL-bearing file and traversal ZIP; each must show a clear error.
- Type `/`, filter, navigate with arrows, select with Enter/Tab or touch, close with Esc, and remove chips. Check the three-skill limit, sent chips and follow-ups after reload; edit/retry/attachments/streaming must still work.
- Repeat in light/dark, desktop/mobile and reduced motion. Sign into a second account and confirm the first account’s instructions and skills are unavailable.
