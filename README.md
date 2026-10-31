<div align="center">

<h1><img src=".github/assets/logo.svg" alt="Bmo" width="120" align="absmiddle" /></h1>

A streaming AI chat workspace and agent built with vanilla JavaScript on the frontend and a lightweight Flask backend proxying NVIDIA inference and Supabase storage. Chat on the web or seamlessly connect via WhatsApp.

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

The client is built with clean, dependency-free HTML, CSS, and modern ES modules—no bundlers or build steps required. The backend is an efficient Flask gateway that validates Supabase user tokens, enforces rate limits, and routes inference to NVIDIA and Mistral endpoints.

## Explainer video

[![Watch Explainer Video](./.github/assets/video-thumbnail.png)](https://youtu.be/WJKiZpZar2E)

---

## Features

- **Passwordless authentication**: Sign in with Google through Supabase OAuth. Tokens are verified using ES256 JWTs against project JWKS keys.
- **Live streaming**: Responses stream using Server-Sent Events with inline Markdown, syntax-highlighted code blocks, and KaTeX rendering.
- **Model routing**: Switch between all-round help (Stanza 2.5 powered by Mistral AI), deep reasoning (Nexos 3.0), and image generation (Iris 2.0).
- **Document parsing**: Drop in PDF, DOCX, XLSX, PPTX, or ZIP files to extract text and analyze contents.
- **Vision processing**: Attach images to route prompts to a vision model.
- **Autonomous web search**: Bmo decides on its own when a question needs live results and searches via TinyFish. A search card above the answer shows the query it ran, the pages it read with their freshness, and how long the search took. Full page scraping for pasted URLs.
- **Voice assistant**: Speech to text and text to speech powered by NVIDIA Riva.
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
│  • Enforces row-level security with service-role key     │
│  • Controls SSE token streams and cancellation           │
└──────────────────────────────────────────────────────────┘
     │                 │                      │
     ▼                 ▼                      ▼
 Supabase          Supabase            NVIDIA endpoints
 Postgres          Storage             • Chat (SSE)
 (RLS)             (Signed URLs)       • Vision & Images
                                       • Riva ASR & TTS
```

## Quick start

### Prerequisites
Python 3.11+, a Supabase account, a [Mistral API key](https://console.mistral.ai/) (powers Stanza 2.5 with `ministral-8b-2512`), and an NVIDIA API key (powers Nexos 3.0, Vision, and TTS).

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

## Project structure

```text
Bmo/
├── backend/
│   ├── app/
│   │   ├── main.py                Flask gateway, streaming routes, model map
│   │   ├── auth.py                JWT and JWKS authentication verification
│   │   ├── store.py               Postgres and Storage data operations
│   │   ├── mistral_client.py      Mistral AI client for Stanza 2.5
│   │   ├── nvidia_client.py       Inference wrapper for OpenAI SDK and NIM
│   │   ├── riva_transcribe.py     Riva speech-to-text integration
│   │   ├── riva_tts.py            Riva text-to-speech integration
│   │   ├── document_processor.py  File parser for PDF, DOCX, XLSX, PPTX, ZIP
│   │   └── analytics.py           Usage metrics calculation
│   ├── migrations/                SQL schema and security policies
│   └── tests/                     Backend unit and API tests
├── frontend/
│   ├── index.html                 Single-page application markup
│   ├── css/styles.css             CSS tokens and component layout
│   └── js/                        Plain ES module components
├── render.yaml                    Render deployment configuration
└── vercel.json                    Vercel frontend configuration
```

## Security

1. **No direct database access**: Requests route through the Flask gateway, which checks identity before accessing data.
2. **Row level security**: Supabase Postgres rules restrict row access to the owning user ID.
3. **Server secrets**: Service role keys and NVIDIA API keys stay on the backend server.
4. **Token verification**: ES256 tokens validate against project JWKS keys on every request.

## Testing

Run tests with pytest:

```bash
cd backend
pytest -v
```

## License

This software is proprietary and confidential. Copyright (c) 2026 Saim Shafique. All rights reserved.
