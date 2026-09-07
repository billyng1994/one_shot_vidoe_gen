# OneTake video studio

OneTake is a three-stage social-video workflow:

1. Generate a square first frame with Higgsfield CLI and GPT Image 2.
2. Use that image job as frame one for Seedance 2.0.
3. Add the GoStudy frame, title, and optional music, then render an H.264 MP4.

## Architecture

The application now runs as two processes:

```text
Browser
  -> Next.js frontend (:3000)
       -> same-origin /api and /media proxy
            -> Express backend (:4000)
                 -> authenticated Higgsfield CLI
                 -> FFmpeg / ffprobe
                 -> persistent backend disk
```

The frontend contains no CLI or filesystem code. The backend owns generation, polling,
provider downloads, rendering, and media serving. It keeps polling submitted jobs even if
the browser closes and resumes unfinished job records after a restart.

Project names and editor settings remain in browser local storage. Generated files and job
metadata are stored on the backend:

```text
backend/data/
  jobs/gen-{image|video}-{uuid}.json
  media/{project-id}/images/*
  media/{project-id}/videos/*
  media/{project-id}/renders/*
```

Set `BACKEND_DATA_DIR` to put this tree elsewhere. Writes are completed with a temporary
file and atomic rename. The browser receives only `/media/...` URLs; provider URLs and disk
paths are not exposed. Deleting a project also asks the backend to remove that project's
media and job records.

## Local development

Requirements: Node.js 20.9+, pnpm 11, FFmpeg/ffprobe, and the Higgsfield CLI.

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

`pnpm dev` starts both services. Open [http://localhost:3000](http://localhost:3000).
The backend binds to `127.0.0.1:4000` by default, and Next.js proxies `/api/*` and
`/media/*` to it.

To run the processes separately:

```bash
pnpm dev:backend
pnpm dev:frontend
```

### Higgsfield authentication

Install and authenticate the CLI on the backend host:

```bash
brew install higgsfield-ai/tap/higgsfield
higgsfield auth login
higgsfield auth token >/dev/null && echo "Higgsfield CLI is authenticated"
```

Do not put OAuth access or refresh tokens in `.env.local`. The backend checks authentication
before every generation. If an older npm-installed launcher reports `env: node: No such file
or directory`, install the native Homebrew release or repair the launcher's Node path.

To exercise the complete API and disk-persistence path without spending credits, set:

```dotenv
HIGGSFIELD_MOCK_MODE=true
```

## Configuration

The main settings in `.env.local` are:

```dotenv
BACKEND_URL=http://127.0.0.1:4000
BACKEND_HOST=127.0.0.1
BACKEND_PORT=4000
BACKEND_DATA_DIR=./data

HIGGSFIELD_CLI_PATH=higgsfield
HIGGSFIELD_IMAGE_MODEL=gpt_image_2
HIGGSFIELD_VIDEO_MODEL=seedance_2_0
HIGGSFIELD_MOCK_MODE=false

FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

Relative `BACKEND_DATA_DIR` values are resolved from the `backend` directory. Optional
concurrency and size limits are documented in [backend/.env.example](backend/.env.example).

## Docker

Docker Compose builds separate frontend and backend images. Only the frontend is published;
the backend stays on the private Compose network. A named volume keeps jobs, images, videos,
and final renders across container replacement.

```bash
docker compose --env-file .env.local up --build
```

Open [http://localhost](http://localhost). The host's `$HOME/.higgsfield` directory is mounted
into the backend container for CLI authentication, and `backend-data` is mounted at `/data`.

```bash
docker compose down
```

`docker compose down` keeps the media volume. Running it with `--volumes` intentionally
removes all backend-stored jobs and media.

## Backend API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | CLI, model, and storage readiness |
| `POST /api/generations/image` | Submit an image generation for a project |
| `POST /api/generations/video` | Submit a video using a completed image job |
| `GET /api/generations/{requestId}` | Read durable job status and local media URL |
| `POST /api/render` | Render and persist the branded final MP4 |
| `DELETE /api/projects/{projectId}/media` | Remove one project's backend artifacts |
| `GET/HEAD /media/*` | Serve stored files, including video byte ranges |

Higgsfield runs with argument arrays and `shell: false`; user prompts never become shell
commands. The backend uses opaque request IDs to map project ownership to provider job IDs.
Only backend-owned media can be passed to the renderer.

This remains a local, single-user application. Before exposing it to the internet, add
authentication, authorization, rate limits, quotas, and a production reverse proxy because
generation endpoints spend credits and rendering consumes substantial CPU and disk.

## Verification

```bash
pnpm check
```

This runs frontend and backend linting/type checks/tests and builds both services.
