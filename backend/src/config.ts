import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { BackendError } from "./errors.js";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = resolve(SOURCE_DIRECTORY, "..");

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BackendError(`${name} must be a positive integer.`, 500, "INVALID_CONFIG");
  }
  return parsed;
}

export type BackendConfig = {
  assetsDir: string;
  corsOrigin?: string;
  dataDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  host: string;
  maxCliConcurrency: number;
  maxImageBytes: number;
  maxMusicBytes: number;
  maxRenderConcurrency: number;
  maxVideoBytes: number;
  mockMode: boolean;
  pollInitialDelayMs: number;
  pollMaxDelayMs: number;
  pollWindowMs: number;
  port: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BackendConfig {
  const configuredDataDir = environment.BACKEND_DATA_DIR?.trim();
  const configuredHost = environment.BACKEND_HOST?.trim() || environment.HOST?.trim();
  const port = positiveInteger(environment.BACKEND_PORT || environment.PORT, 4000, "BACKEND_PORT");

  if (port > 65_535) {
    throw new BackendError("BACKEND_PORT must be at most 65535.", 500, "INVALID_CONFIG");
  }

  return {
    assetsDir: resolve(BACKEND_ROOT, "assets"),
    corsOrigin: environment.BACKEND_CORS_ORIGIN?.trim() || undefined,
    dataDir: configuredDataDir
      ? resolve(BACKEND_ROOT, configuredDataDir)
      : resolve(BACKEND_ROOT, "data"),
    ffmpegPath: environment.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: environment.FFPROBE_PATH?.trim() || "ffprobe",
    host: configuredHost || "127.0.0.1",
    maxCliConcurrency: positiveInteger(
      environment.BACKEND_MAX_CLI_CONCURRENCY,
      2,
      "BACKEND_MAX_CLI_CONCURRENCY",
    ),
    maxImageBytes: positiveInteger(
      environment.BACKEND_MAX_IMAGE_BYTES,
      30 * 1024 * 1024,
      "BACKEND_MAX_IMAGE_BYTES",
    ),
    maxMusicBytes: positiveInteger(
      environment.BACKEND_MAX_MUSIC_BYTES,
      40 * 1024 * 1024,
      "BACKEND_MAX_MUSIC_BYTES",
    ),
    maxRenderConcurrency: positiveInteger(
      environment.BACKEND_MAX_RENDER_CONCURRENCY,
      1,
      "BACKEND_MAX_RENDER_CONCURRENCY",
    ),
    maxVideoBytes: positiveInteger(
      environment.BACKEND_MAX_VIDEO_BYTES,
      250 * 1024 * 1024,
      "BACKEND_MAX_VIDEO_BYTES",
    ),
    mockMode: environment.HIGGSFIELD_MOCK_MODE === "true",
    pollInitialDelayMs: positiveInteger(
      environment.BACKEND_POLL_INITIAL_DELAY_MS,
      2_000,
      "BACKEND_POLL_INITIAL_DELAY_MS",
    ),
    pollMaxDelayMs: positiveInteger(
      environment.BACKEND_POLL_MAX_DELAY_MS,
      10_000,
      "BACKEND_POLL_MAX_DELAY_MS",
    ),
    pollWindowMs: positiveInteger(
      environment.BACKEND_POLL_WINDOW_MS,
      12 * 60_000,
      "BACKEND_POLL_WINDOW_MS",
    ),
    port,
  };
}
