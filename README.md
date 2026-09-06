# OneTake video studio

A three-stage social-video workflow:

1. Generate a square first frame with Higgsfield CLI and **GPT Image 2**.
2. Use that completed image job as frame one for **Seedance 2.0**.
3. Add the GoStudy frame, drag a title into position, upload background music, and render an H.264 MP4.

## Project workspaces

The front page is a project library with saved first-frame previews and workflow status. Open a card to enter its `/projects/{id}` workspace, then use the project controls beside the OneTake logo to create, switch, rename, or delete projects. Each project keeps its own prompts, workflow step, generated image/video job IDs and URLs, motion settings, and title layout. Project URLs can be refreshed or bookmarked in the same browser.

Projects are stored locally in the current browser. An existing single-workspace `onetake:studio:v1` snapshot is migrated automatically into **My first project**. Project data does not sync between browsers or devices, and uploaded music still needs to be selected again after a refresh.

## Higgsfield CLI authentication

This project uses the logged-in Higgsfield CLI rather than Cloud REST API keys. Do not put OAuth access or refresh tokens in `.env.local`.

Install the CLI on the host and sign in:

```bash
brew install higgsfield-ai/tap/higgsfield
higgsfield auth login
```

The app expects the CLI login files in `$HOME/.higgsfield`. To explicitly create or refresh that login:

```bash
mkdir -p "$HOME/.higgsfield"
HIGGSFIELD_CREDENTIALS_PATH="$HOME/.higgsfield/credentials.json" \
HIGGSFIELD_CONFIG_PATH="$HOME/.higgsfield/config.json" \
higgsfield auth login
```

Verify authentication without displaying the token:

```bash
higgsfield auth token >/dev/null && echo "Higgsfield CLI is authenticated"
higgsfield model get gpt_image_2 --json
higgsfield model get seedance_2_0 --json
```

If an older npm-installed `higgsfield` launcher reports `env: node: No such file or directory`, install the native Homebrew release or fix the launcher before running locally. Docker uses its own pinned native CLI binary.

## Configuration

Copy the example environment file if needed:

```bash
cp .env.example .env.local
```

The defaults are:

```dotenv
HIGGSFIELD_CLI_PATH=higgsfield
HIGGSFIELD_IMAGE_MODEL=gpt_image_2
HIGGSFIELD_VIDEO_MODEL=seedance_2_0
HIGGSFIELD_MOCK_MODE=false
```

For Step 1, the adapter also supports `nano_banana`, `nano_banana_2`, `nano_banana_2_lite`, and `nano_banana_flash`. Model schemas are checked with `higgsfield model get` immediately before a generation is submitted.

## Run with Docker

The image includes Node.js, Higgsfield CLI 1.1.24, FFmpeg, `ffprobe`, and Noto CJK fonts. Compose mounts `$HOME/.higgsfield` at runtime so OAuth credentials are not copied into an image layer.

```bash
docker compose --env-file .env.local up --build
```

Open [http://localhost](http://localhost). Docker maps host port 80 to the app's internal port 3000. On a server, protect the app with authentication because its generation routes can spend account credits.

Stop the container with:

```bash
docker compose down
```

If credentials are not configured, set `HIGGSFIELD_MOCK_MODE=true` and select **Open a sample project** to test the editor and MP4 export without spending generation credits.

## Run locally

Requirements: Node.js 20.9+, pnpm, FFmpeg, and an authenticated `higgsfield` executable on `PATH`.

```bash
pnpm install
pnpm dev
```

To use explicit binary locations, add these optional values to `.env.local`:

```dotenv
HIGGSFIELD_CLI_PATH=/absolute/path/to/higgsfield
FFMPEG_PATH=/absolute/path/to/ffmpeg
FFPROBE_PATH=/absolute/path/to/ffprobe
```

## CLI integration

The browser calls only local Next.js route handlers. Those handlers run the CLI with an argument array and no shell, keeping prompts from becoming shell commands.

| Stage | Server-side command |
| --- | --- |
| Still | `higgsfield --json --no-color generate create gpt_image_2 ...` |
| Motion | `higgsfield --json --no-color generate create seedance_2_0 --start-image=JOB_ID ...` |
| Status | `higgsfield --json --no-color generate get JOB_ID` |

Global output flags are placed before the command, and dynamic parameters use `--name=value`, so prompt text cannot consume a CLI flag. The immediate CLI response is normalized from `{ id, job_type, credits }` into the app's request shape; a strictly validated bare job UUID is also accepted for CLI versions that fall back to human output. Completed CLI jobs are normalized from their `status` and `result_url` fields. The image job UUID—not an untrusted URL or filesystem path—is passed to Seedance as its first-frame reference.

Before submitting Step 1, the server reuses a matching image job from the previous 30 minutes. If the CLI submits successfully but returns an unusable response, the server also recovers the exact job by model, prompt, and submission time. This avoids duplicate credit charges after a response-format failure.

The same recovery applies to Seedance using the effective motion prompt, source-image job, duration, resolution, aspect ratio, mode, and audio setting. The browser stores each project's image/video job IDs and URLs, prompts, workflow step, and editor settings in a separate versioned local workspace. On refresh it asks Higgsfield for the authoritative job status and resumes polling unfinished jobs. Uploaded music files must be selected again after a refresh because browsers do not persist local `File` objects.

The CLI uses a browser OAuth session and is appropriate for this local, single-user application. For an internet-facing multi-user service, use Higgsfield's server API/SDK with application authentication, authorization, rate limiting, and durable job ownership records.

Official references:

- [Higgsfield CLI](https://github.com/higgsfield-ai/cli)
- [CLI model schemas](https://github.com/higgsfield-ai/cli/blob/main/MODELS.md)
- [Higgsfield REST and SDK documentation](https://docs.higgsfield.ai/docs/index)

## Rendering notes

The included FFmpeg renderer is synchronous and designed for a local MVP or a long-running Node server. Allow roughly 500 MB of writable temporary disk per active render. Compose gives an in-progress FFmpeg render up to 330 seconds to finish during graceful shutdown.

## Checks

```bash
pnpm check
```
