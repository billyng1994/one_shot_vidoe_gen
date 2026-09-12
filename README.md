# OneTake video studio

OneTake is a three-stage social-video workflow:

1. Generate a square first frame with Higgsfield CLI and GPT Image 2.
2. Use that image job as frame one for Seedance 2.0.
3. Add the GoStudy frame, title, and optional music, then render an H.264 MP4.

## Architecture and storage

The application runs as two processes:

```text
Browser
  -> Next.js frontend (:3000)
       -> same-origin /api and /media proxy
            -> Express backend (:4000)
                 -> authentication and per-user authorization
                 -> authenticated Higgsfield CLI
                 -> FFmpeg / ffprobe
                 -> persistent backend disk
```

The frontend contains no CLI or filesystem code. The backend owns accounts, sessions,
projects, generation, polling, provider downloads, rendering, and media serving. It keeps
polling submitted jobs if the browser closes and resumes unfinished job records after a
restart.

OneTake does **not** use `localStorage` or `sessionStorage`. The only browser-persisted
application state is an opaque, `HttpOnly`, `SameSite=Strict` session cookie. JavaScript
cannot read the cookie; the CSRF token returned for an authenticated session is held in
memory. Project names and complete editor snapshots are saved on the backend and isolated
by account.

All durable OneTake application data lives under `BACKEND_DATA_DIR`:

```text
backend/data/                         # default for a local backend
  auth/
    store.json                        # users, password hashes, session hashes, audit log
  projects/
    <user-id>/
      <project-id>.json               # name and complete editor snapshot
  jobs/
    gen-image-<uuid>.json
    gen-video-<uuid>.json
  media/
    <project-id>/
      images/*
      videos/*
      renders/*
```

Set `BACKEND_DATA_DIR` to move this tree. Records are written with a temporary file and
atomic rename. Passwords use salted scrypt hashes, and raw session tokens are never written
to disk. The browser receives only `/media/...` URLs; provider URLs and backend disk paths
are not exposed. Project, job, and media access is checked against the signed-in owner.
Deleting a project removes its project record, media, and job records.

Back up the entire data directory as one unit and restrict it to the backend service account.
It contains password hashes and active session hashes in addition to generated media.
Docker keeps the Higgsfield OAuth files separately in the private
`one-shot-video-studio_higgsfield-auth` named volume. Those provider credentials never pass
through the API and are never sent to the browser.

## Local development

Requirements: Node.js 20.9+, pnpm 11, FFmpeg/ffprobe, and the Higgsfield CLI.

```bash
cp .env.example .env.local
openssl rand -base64 32
```

Paste the generated value into `BACKEND_BOOTSTRAP_TOKEN` in `.env.local`, then start both
services:

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Plain HTTP is accepted only for the
browser's loopback development exception. On first load, create the first administrator
with the same bootstrap token. The token must contain at least 32 characters and is used
only for that one-time bootstrap; keep it out of source control and rotate it after setup.

The backend binds to `127.0.0.1:4000` by default, and Next.js proxies `/api/*` and
`/media/*` to it. To run the processes separately:

```bash
pnpm dev:backend
pnpm dev:frontend
```

### Higgsfield authentication for native development

When running the backend directly with `pnpm dev`, install and authenticate the CLI as the
same operating-system user that runs the backend:

```bash
brew install higgsfield-ai/tap/higgsfield
higgsfield auth login
higgsfield auth token >/dev/null && echo "Higgsfield CLI is authenticated"
```

Do not put OAuth access or refresh tokens in `.env.local`. The backend checks authentication
before every generation. If an older npm-installed launcher reports `env: node: No such file
or directory`, install the native Homebrew release or repair the launcher's Node path. Docker
uses the separate container workflow below; it does not read the host user's CLI files.

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

BACKEND_BOOTSTRAP_TOKEN=<at-least-32-random-characters>
BACKEND_AUTH_COOKIE_SECURE=false
BACKEND_AUTH_SESSION_TTL_MS=604800000
BACKEND_LOGIN_ATTEMPT_LIMIT=5
BACKEND_LOGIN_WINDOW_MS=900000

HIGGSFIELD_CLI_PATH=higgsfield
HIGGSFIELD_IMAGE_MODEL=gpt_image_2
HIGGSFIELD_VIDEO_MODEL=seedance_2_0
HIGGSFIELD_MOCK_MODE=false

FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

`BACKEND_AUTH_SESSION_TTL_MS` is the session lifetime in milliseconds (the default shown is
seven days). Login failures are limited per normalized email address to
`BACKEND_LOGIN_ATTEMPT_LIMIT` within `BACKEND_LOGIN_WINDOW_MS`; successful login clears that
entry. The in-memory rate-limit window resets when the backend restarts, so an internet-facing
deployment should also rate-limit at its reverse proxy.

Relative `BACKEND_DATA_DIR` values are resolved from the `backend` directory. Optional
concurrency, poll, upload-size, and CORS settings are documented in
[backend/.env.example](backend/.env.example).

## HTTPS and Docker

Passwords must never cross a remote network over plain HTTP. The bundled frontend disables
login, initial setup, and account changes when opened from a non-loopback HTTP origin. For
every remote or production deployment:

1. Terminate trusted HTTPS at a reverse proxy or load balancer in front of the frontend.
2. Set `BACKEND_AUTH_COOKIE_SECURE=true` so the session cookie receives the `Secure` flag and
   the `__Host-` cookie prefix.
3. Expose the frontend only through that TLS endpoint; do not publish its HTTP port directly
   to the internet.
4. Persist and back up `BACKEND_DATA_DIR` and protect the Higgsfield authentication volume.

Docker Compose builds separate frontend and backend images. The backend stays on the private
Compose network, and the frontend HTTP port binds to `127.0.0.1` by default. The
`backend-data` volume keeps OneTake accounts, project snapshots, jobs, images, videos, and
renders. The separately named `one-shot-video-studio_higgsfield-auth` volume is mounted at
`/home/backend/.higgsfield` and keeps the backend CLI login across container replacement.
There is no host-home bind mount, so running Compose as a different VM user cannot silently
select the wrong credentials directory.

Before starting, fill the blank `BACKEND_BOOTSTRAP_TOKEN` in `.env.local`. Docker Compose
deliberately refuses to start without it:

```bash
docker compose --env-file .env.local up --build
```

For local use, open [http://localhost](http://localhost) and leave
`BACKEND_AUTH_COOKIE_SECURE=false`. For a TLS deployment, leave the Compose port bound to
loopback for the host reverse proxy and set `BACKEND_AUTH_COOKIE_SECURE=true`. Internal
frontend-to-backend traffic can remain HTTP on the private Compose network; the browser-facing
origin must be HTTPS.

### Connect Higgsfield in Docker

Only an administrator can see provider diagnostics. In OneTake, open the account menu, choose
the **Provider** tab, and follow its displayed SSH-tunnel and server-login commands. Run the
server command on the Docker host—not in the browser. When OAuth succeeds, return to the
Provider tab and choose **Recheck connection**. The tab requests only
installed/authenticated status, CLI version, selected models, and setup commands. Access
tokens, refresh tokens, and credential-file contents never reach the frontend.

The [official Higgsfield CLI v1.1.24](https://github.com/higgsfield-ai/cli/tree/v1.1.24)
`auth login` flow uses OAuth 2.0 PKCE and an HTTP loopback callback. It accepts `--port`,
generates a `http://localhost:<port>/callback` redirect, and listens on `127.0.0.1` only. On a
remote Linux VM, keep that callback private with an SSH tunnel. From a terminal on the computer
where you will open the authorization page, connect without `sudo` and use the CLI's registered
default callback port:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 8765:127.0.0.1:8765 <vm-user>@<vm-host>
```

After SSH accepts your password, a blank terminal is expected: the tunnel is running. Keep that
terminal open; do not press `Ctrl+Z`, which suspends SSH while leaving port 8765 reserved. Open a
second terminal, SSH to the VM normally, change to the project directory, and run the Provider-tab
command:

```bash
docker run --rm -it --network host \
  --mount source=one-shot-video-studio_higgsfield-auth,target=/home/backend/.higgsfield \
  --entrypoint /usr/local/bin/higgsfield \
  one-shot-video-backend:local auth login --port 8765
```

If Docker reports permission denied for its socket, rerun only the Docker command with `sudo`.
Do not use `sudo` for the local SSH command.

If SSH reports `Address already in use`, do not create another tunnel. In the terminal where the
previous tunnel was started, run `jobs`, then `fg %1` (replace `1` with the displayed job number)
to resume it and leave it open. Alternatively, bring it to the foreground and press `Ctrl+C` to
stop it before retrying.

Open the authorization URL printed by the command in your local browser. Its localhost
callback travels through SSH to the VM loopback interface and the one-off backend container.
Do not open port 8765 in the VM firewall, cloud security group, reverse proxy, or Compose;
the callback should remain loopback-only. `--network host` is intended for the Linux Docker
Engine on the VM.

The one-off container and the running backend share the same named volume. After login, this
non-secret check should succeed, and **Recheck connection** should report ready without a
backend restart:

```bash
docker compose --env-file .env.local exec backend \
  /usr/local/bin/higgsfield auth token >/dev/null \
  && echo "Backend Higgsfield authentication is valid"
```

```bash
docker compose down
```

`docker compose down` keeps both named volumes. Running it with `--volumes` intentionally and
irreversibly removes accounts, project records, jobs, generated media, and the container's
Higgsfield login. You must authenticate the provider again after deleting that auth volume.

## Accounts and user management

The first account is an administrator created through one-time bootstrap. After that, only an
administrator can create accounts. Administrators can change a user's name, email, role,
password, and enabled status, and can revoke all of that user's sessions. Accounts are disabled
instead of deleted so project ownership and the audit history remain intact. The final enabled
administrator cannot be disabled or demoted.

Every mutating authenticated API request requires the session-bound `X-CSRF-Token` plus
`X-OneTake-Request: 1`. The bundled frontend adds these automatically. Direct API clients must
first obtain the CSRF token from `GET /api/auth/session` while retaining the session cookie.

## Backend API

| Access | Endpoint | Purpose |
| --- | --- | --- |
| Public | `GET /api/health?check=liveness` | Lightweight process liveness check |
| Public | `GET /api/auth/session` | Read setup status or the signed-in user and CSRF token |
| Public | `POST /api/auth/bootstrap` | Create the first administrator with the bootstrap token |
| Public | `POST /api/auth/login` | Authenticate and set the `HttpOnly` session cookie |
| User | `POST /api/auth/logout` | Revoke the current session and clear its cookie |
| User | `PATCH /api/account/profile` | Change the current user's display name |
| User | `POST /api/account/password` | Verify and change the current password; rotate sessions |
| User | `GET /api/projects` | List the current user's projects |
| User | `POST /api/projects` | Create a project |
| User | `GET/PATCH/DELETE /api/projects/{projectId}` | Read, save, or delete an owned project |
| User | `POST /api/generations/image` | Submit an image generation for an owned project |
| User | `POST /api/generations/video` | Submit a video using a completed image job |
| User | `GET /api/generations/{requestId}` | Read an owned durable job and local media URL |
| User | `POST /api/render` | Render and persist the branded final MP4 |
| User | `DELETE /api/projects/{projectId}/media` | Remove one project's generated artifacts and jobs |
| User | `GET /api/health` | Read CLI, model, and storage readiness |
| User | `GET/HEAD /media/*` | Serve authorized stored files, including video ranges |
| Admin | `GET /api/admin/provider` | Recheck sanitized backend CLI and provider readiness |
| Admin | `GET/POST /api/admin/users` | List or create users |
| Admin | `PATCH /api/admin/users/{userId}` | Update identity, role, password, or enabled status |
| Admin | `POST /api/admin/users/{userId}/revoke-sessions` | Revoke a user's sessions |
| Admin | `GET /api/admin/audit` | Read recent authentication and administration events |

Higgsfield runs with argument arrays and `shell: false`; user prompts never become shell
commands. The backend uses opaque request IDs to map project ownership to provider job IDs.
Only backend-owned media can be passed to the renderer.

## Verification

```bash
pnpm check
```

This runs frontend and backend linting, type checks, tests, and builds both services.
