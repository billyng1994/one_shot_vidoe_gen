# One-shot backend

Express 5 owns all Higgsfield CLI and FFmpeg processes. Provider URLs are downloaded into the configured data directory before they are exposed to the browser.

## Run

```sh
cd backend
pnpm install
pnpm dev
```

The service reads the project-root `.env.local` without overriding environment variables already supplied by the host. It listens on `127.0.0.1:4000` by default. Set `BACKEND_HOST=0.0.0.0` in a container and mount `BACKEND_DATA_DIR` on persistent storage.

The API intentionally has no separate user-authentication layer. Keep it on loopback or a private container network and expose it only through the authenticated frontend/reverse proxy; do not publish its port directly to the internet. Remote downloads are accepted only from HTTPS URLs emitted by the CLI and are checked for public DNS addresses before each redirect.

`HIGGSFIELD_MOCK_MODE=true` exercises the same durable job and media paths with `assets/demo-image.svg` and `assets/demo-video.mp4`. Read-only samples are also available at `/media/samples/demo-image.svg` and `/media/samples/demo-video.mp4`.

## API

- `GET /api/health` (`?check=liveness` skips CLI checks)
- `POST /api/generations/image` with `{ projectId, prompt }`
- `POST /api/generations/video` with `{ projectId, prompt, imageRequestId, duration, resolution, cameraFixed }`
- `GET /api/generations/:requestId`
- `POST /api/render` as multipart form data with `projectId`, `videoUrl`, title placement fields, and optional `music`
- `DELETE /api/projects/:projectId/media`
- `GET|HEAD /media/**`, including single byte-range requests

Generation IDs are opaque `gen-image-<uuid>` or `gen-video-<uuid>` IDs. JSON job records live under `BACKEND_DATA_DIR/jobs`; generated and rendered files live under `BACKEND_DATA_DIR/media`. Writes use a same-directory temporary file followed by rename.
