# Libitu

[中文](README.md) | **English**

Libitu is an AI English-learning app that turns authentic expressions from YouTube videos into a personal language collection, shadowing exercises, and scenario-based conversations—helping you put the English you understand into practice.

> Currently in local development; not yet launched. English videos are supported, and caption availability depends on the source.

## Features

- **Learn from videos**: paste a YouTube link or use the Chrome extension to explore captions, content summaries, and useful expressions.
- **Build a personal collection**: save, filter, and edit chunks, idioms, and sentence structures with their original context.
- **Practice sentence by sentence**: record and replay your voice, check the words you spoke, and explore Sound, Rhythm, and Melody feedback covering timing, pauses, rhythm, and pitch. Optionally prepare reference audio for comparison.
- **Have AI conversations**: choose expressions to practice, set a scenario and goal, and talk to AI through real-time voice or text.
- **Review your practice**: read session reports backed by quotes from your conversation, and revisit your practice history and learning activity.

Move straight from saved expressions to a conversation, or practice shadowing first. Acoustic feedback and session scores are still being evaluated; they are not calibrated pronunciation diagnostics or general English proficiency assessments.

## Tech stack

Next.js 15 · React 19 · TypeScript · FastAPI · Supabase · Clerk · Upstash Redis · Doubao text · Gemini Live

The monorepo uses pnpm and Turborepo. Server-side shadowing analysis uses faster-whisper, MFA, Silero VAD, and Praat.

## Run locally

### 1. Prerequisites

- Node.js 22.18+ (22.x) and pnpm 10.19.0
- Python 3.11–3.14 and [uv](https://docs.astral.sh/uv/)
- A Clerk development application for the current Web authentication integration
- Chrome for the extension and reference-audio capture

```bash
git clone https://github.com/kongshan33/libitu.git
cd libitu
pnpm install

cd apps/api
uv sync --extra dev --extra acoustics
cd ../..
```

### 2. Configure environment variables

Copy the templates on first setup. If configuration files already exist, edit them instead of overwriting them:

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env
```

For basic development, configure:

| File | Configuration |
| --- | --- |
| `apps/web/.env.local` | Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`; keep `NEXT_PUBLIC_LIBITU_API_BASE_URL=http://localhost:8000` |
| `apps/api/.env` | Set `CLERK_SECRET_KEY` from the same Clerk application; keep `CLERK_AUTHORIZED_PARTIES=http://localhost:3000` and `PROCESSING_MODE=inline` |

`inline` uses deterministic development data and in-memory storage for exploring the UI and API. It does not run real AI video analysis or provide the complete persistence, speech analysis, and live conversation experience.

### 3. Start the Web app and API

Open two terminals at the repository root:

```bash
# Terminal 1: API
pnpm --filter @libitu/api dev:server
```

```bash
# Terminal 2: Web
pnpm --filter @libitu/web dev
```

Open the [Web app](http://localhost:3000) or [API documentation](http://localhost:8000/docs).

### 4. Enable additional features

Add the relevant settings to `apps/api/.env`. See the [API environment template](apps/api/.env.example) for variable names:

| Feature | Additional setup |
| --- | --- |
| Persistent data and practice history | Configure your own Supabase project, apply the migrations in `supabase/migrations` in order, and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` |
| Real video analysis | With persistence configured, set `PROCESSING_MODE=queue`, the Upstash REST URL / token, and `ARK_API_KEY`; run `pnpm --filter @libitu/api setup:punctuation` to prepare the subtitle punctuation model |
| AI voice conversations and session reports | With persistence configured, set `GEMINI_API_KEY` and `ARK_API_KEY`, and keep `SPEAKING_REALTIME_PROVIDER=gemini`; check that your provider account has access to the configured models |
| Server-side shadowing analysis | With persistence configured, install FFmpeg and MFA, prepare the ASR model, acoustic model, and dictionary, and configure their paths and checksums; see the [acoustic runtime guide](apps/api/deploy/README.md) |

Text analysis uses `ARK_API_KEY` and defaults to `ARK_MODEL=doubao-seed-2-1-lite-260915`. Voice retains its separate `GEMINI_API_KEY` and `GEMINI_LIVE_MODEL`.

For video analysis or conversations, start the workers you need alongside the Web app and API:

```bash
pnpm --filter @libitu/api worker
pnpm --filter @libitu/api worker:feedback
```

Run each worker in a separate terminal. Once all services and acoustic models are configured, use `pnpm dev` at the root to start the Web app, API, video analysis, session reports, and both acoustic workers together. **Until the database and acoustic models are configured, use the separate startup commands above.**

AI features require your own provider accounts and credentials and may incur usage charges. Keep secrets in local environment files and out of Git.

### 5. Install the Chrome extension (optional)

1. Open `chrome://extensions` in Chrome and enable Developer mode.
2. Click **Load unpacked** and select `apps/extension` from the repository.
3. Open an English YouTube video and click the Libitu player button or toolbar icon.

The extension connects to `http://localhost:3000` by default. Reference-audio capture requires explicit permission through the on-screen setup. After updating the Web app or extension, reload the extension and refresh the relevant pages. See the [extension guide](apps/extension/README.md).

## Development

```text
apps/web        Web application
apps/api        API and background workers
apps/extension  Chrome extension
packages        Shared types, business utilities, and UI configuration
supabase        Database migrations
design/docs     Product and implementation documentation
```

```bash
# Start from the repository root
cd apps/api
uv sync --extra dev --extra acoustics

# Run from the repository root
cd ../..
pnpm lint
pnpm test
pnpm build
```

Issues and pull requests are welcome. Read the [development conventions](CLAUDE.MD) before contributing; see [PROJECT.MD](PROJECT.MD) and [TASK.MD](TASK.MD) for current progress and planned work.
