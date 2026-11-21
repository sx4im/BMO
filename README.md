<div align="center">

<h1><img src=".github/assets/logo.svg" alt="Bmo" width="120" align="absmiddle" /></h1>

A streaming AI chat workspace and agent built with vanilla JavaScript on the frontend and a lightweight Flask backend that routes inference to NVIDIA, Mistral, and Groq and stores data in Supabase. Chat on the web, talk to Bmo by voice, or connect via WhatsApp.

[![Live demo](https://img.shields.io/badge/Live_demo-bimo.qzz.io-d97757?style=flat-square)](https://bimo.qzz.io)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/sx4im/BMO?style=flat-square)](https://github.com/sx4im/BMO/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/sx4im/BMO?style=flat-square)](https://github.com/sx4im/BMO/network/members)
[![Issues](https://img.shields.io/github/issues/sx4im/BMO?style=flat-square)](https://github.com/sx4im/BMO/issues)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-gateway-000000?style=flat-square&logo=flask)](https://flask.palletsprojects.com/)

[Live demo](https://bimo.qzz.io) | [Report an issue](https://github.com/sx4im/BMO/issues)

</div>

---

## What is Bmo

Bmo is a fast, full-featured AI workspace and agent. It streams responses token by token via Server-Sent Events, renders live Markdown, code blocks with syntax highlighting, and math expressions, and supports image generation, document parsing, and bidirectional voice interaction.

The client is built with clean, dependency-free HTML, CSS, and modern ES modules—no bundlers or build steps required. The backend is an efficient Flask gateway that validates Supabase user tokens, enforces rate limits, and routes inference to NVIDIA, Mistral, and Groq, and proxies search and speech providers.

## Explainer video

[![Watch Explainer Video](./.github/assets/video-thumbnail.png)](https://youtu.be/WJKiZpZar2E)

---

## Features

- **Passwordless authentication**: Sign in with Google through Supabase OAuth. Tokens are verified using ES256 JWTs against project JWKS keys.
- **Live streaming**: Responses stream using Server-Sent Events with inline Markdown, syntax-highlighted code blocks, and KaTeX rendering.
- **Model routing**: Switch between all-round help (Stanza 2.5, Mistral), deep reasoning with optional extended thinking (Nexos 3.0, NVIDIA), and image generation (Iris 2.0, FLUX).
- **Projects and Customize**: Group chats with project instructions and knowledge files, set global instructions, and add text-only skills with `@` mentions in the composer.
- **Sharing and export**: Share a read-only snapshot of a chat, branch a conversation, pin chats, and export answers to DOCX or PDF.
- **WhatsApp**: Chat with Bmo (Aeon on Groq Qwen) through the Meta WhatsApp Cloud API.
- **Document parsing**: Drop in PDF, DOCX, XLSX, PPTX, or ZIP files to extract text and analyze contents.
- **Vision processing**: Attach images to route prompts to a vision model.
- **Autonomous web search**: Bmo decides on its own when a question needs live results and searches via TinyFish. A search card above the answer shows the query it ran, the pages it read with their freshness, and how long the search took. Full page scraping for pasted URLs.
- **Voice assistant**: Streaming speech to text (Deepgram Nova-3, with Whisper verification for Auto language) and text to speech (Deepgram Flux) across 42 languages. Dictation in the composer is transcribed server-side.
- **Usage limits**: Weighted token metering with a 5-hour session window and a weekly window.
- **Server cancellation**: Stopping a response halts generation on the server immediately using an internal stream registry.

## System architecture

```text
                     Google OAuth
  Browser  ───────────────────────────────>  Supabase Auth
     │  <───────────────  ES256 JWT  ──────────────┘
     │
     │   Authorization: Bearer <jwt>
     ▼
┌──────────────────────────────────────────────────────────┐
│                      Flask gateway                       │
│  • Verifies JWTs against Supabase JWKS                   │
│  • Enforces ownership checks with the service-role key   │
│  • Controls SSE token streams and cancellation           │
│  • Routes each turn: search decision, model, fallback    │
└──────────────────────────────────────────────────────────┘
   │          │            │            │           │
   ▼          ▼            ▼            ▼           ▼
Supabase  Supabase      NVIDIA       Mistral      Groq
Postgres  Storage       Nexos 3.0    Stanza 2.5   Aeon (WhatsApp, Voice,
(RLS)     (Signed URLs) Vision       (chat)       search classifier,
                        Iris images               titles)

Also: TinyFish (search/scrape), Deepgram (STT/TTS), Meta WhatsApp Cloud API
```

Model lanes:

| Lane | Id | Provider | Default model |
|---|---|---|---|
| Stanza 2.5 | `thinking` | Mistral | `ministral-8b-2512` |
| Nexos 3.0 | `deep` | NVIDIA | `z-ai/glm-5.3-flash` |
| Bmo Voice / WhatsApp | `aeon` | Groq | `qwen/qwen3.8-27b` |
| Vision | n/a | NVIDIA | `google/diffusiongemma-26b-a4b-it` |
| Iris 2.0 | `image` | NVIDIA | `black-forest-labs/flux-3-image-klein` |


## Quick start

### Prerequisites
Python 3.11+, a Supabase account, a [Mistral API key](https://console.mistral.ai/) (Stanza 2.5), a [Groq API key](https://console.groq.com/keys) (Aeon: WhatsApp, Voice, search routing, titles), an NVIDIA API key (Nexos 3.0, Vision, image generation), and optionally TinyFish (web search) and Deepgram (voice) keys.

### 1. Database setup
Run these forward migrations from `backend/migrations/` in order inside your Supabase project SQL editor. Files ending in `_down.sql` undo migrations; use them only for an intentional rollback.
1. `0001_init.sql` — base schema (profiles, conversations, messages, feedback, storage bucket, RLS)
2. `0002_message_reasoning.sql` — adds `reasoning` column to messages
3. `0003_usage_events.sql` — token metering and usage tracking
4. `0004_onboarding.sql` — onboarding surveys and profile flags
5. `0005_conversation_pinned.sql` — pinned conversation support
6. `0006_shared_conversations.sql` — public conversation snapshots
7. `0007_projects.sql` — projects, knowledge files, and conversation membership
8. `0008_projects_hardening.sql` — project constraints and ownership validation
9. `0009_customize.sql` — global instructions, text-only skills, RLS and chat selections

See [Customize](docs/CUSTOMIZE.md) for deployment order, import limits, API details and the manual test checklist.

### 2. Start the backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m app.main
```
Verify the server with `curl http://localhost:8000/health`.

Chat cancellation uses a private SQLite registry shared by Gunicorn workers on
the same host. Set `BMO_STATE_DIR` to a writable private directory to override
its default temporary location. Deployments spanning multiple hosts must use
shared coordination before enabling that topology; separate local files do
not provide cross-host cancellation.

### 3. Start the frontend
```bash
cd frontend
python -m http.server 5500
```
Open `http://localhost:5500` in your browser. Configure your Supabase URL and backend origin in Settings.

### Model configuration
- **Stanza 2.5**: `MISTRAL_API_KEY`; override with `MISTRAL_MODEL` and `MISTRAL_BASE_URL`.
- **Nexos 3.0**: `NVIDIA_API_KEY` and `NVIDIA_NEXOS_MODEL`. Use NVIDIA's dotted id `z-ai/glm-5.3-flash`.
- **Aeon**: `GROQ_API_KEY` with `GROQ_AEON_MODEL` (then `GROQ_MODEL`, legacy `NVIDIA_AEON_MODEL`, or the default).
- Provider errors surface directly. Without Groq, search falls back to rules and semantic Voice checks report unavailable. Legacy `NVIDIA_STANZA_MODEL` is ignored.
- See `backend/.env.example` for every variable and `render.yaml` for the deployed set.

## Project structure

```text
Bmo/
├── backend/
│   ├── app/
│   │   ├── main.py                Flask app factory, blueprints, security headers
│   │   ├── config.py              Model catalog, quotas, upload allowlists
│   │   ├── routes/                chat, user, media, project, customize, export, analytics
│   │   ├── auth.py                JWT and JWKS verification
│   │   ├── store.py               Postgres and Storage data operations
│   │   ├── chat_generation.py     Completion and bounded continuation
│   │   ├── chat_persistence.py    Durable turn writer
│   │   ├── search_router.py       Search decision (rules + classifier) and TinyFish
│   │   ├── nvidia_client.py       Nexos, vision, and image inference
│   │   ├── mistral_client.py      Stanza inference
│   │   ├── groq_client.py         Aeon inference
│   │   ├── whatsapp.py            WhatsApp Cloud API webhook
│   │   ├── voice_turns.py         Voice turn handling
│   │   ├── deepgram_tts.py        Streaming text-to-speech
│   │   ├── riva_transcribe.py     Speech-to-text fallback providers
│   │   ├── document_processor.py  PDF, DOCX, XLSX, PPTX, ZIP parsing
│   │   ├── skill_service.py       Skills and prompt assembly
│   │   └── project_service.py     Project knowledge handling
│   ├── migrations/                SQL schema and security policies
│   └── tests/                     Backend unit and API tests
├── frontend/
│   ├── index.html                 Single-page application shell
│   ├── css/styles.css             CSS tokens and component layout
│   ├── js/                        pages/, chat/ (composer, stream), components/
│   └── tests/                     Frontend regression tests (jsdom)
├── docs/                          Project context, verification records
├── render.yaml                    Render backend deployment
├── vercel.json                    Vercel frontend configuration
└── docker-compose.yml             Local container setup
```

## Security

1. **No direct database access**: Requests route through the Flask gateway, which checks identity before accessing data.
2. **Row level security**: Supabase Postgres rules restrict row access to the owning user ID.
3. **Server secrets**: Service role keys and all provider API keys (NVIDIA, Mistral, Groq, Deepgram, TinyFish) stay on the backend server.
4. **Token verification**: ES256 tokens validate against project JWKS keys on every request.

## Testing

```bash
cd backend && pytest -q                          # backend
cd frontend && npm install && npm run test:run   # frontend (jsdom)
```

## License

This software is proprietary and confidential. Copyright (c) 2026 Saim Shafique. All rights reserved.
