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

function booleanValue(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BackendError(`${name} must be true or false.`, 500, "INVALID_CONFIG");
}

function corsOrigin(value: string | undefined) {
  const configured = value?.trim();
  if (!configured) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new BackendError(
      "BACKEND_CORS_ORIGIN must be an HTTP(S) origin.",
      500,
      "INVALID_CONFIG",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new BackendError(
      "BACKEND_CORS_ORIGIN must be an HTTP(S) origin without credentials or a path.",
      500,
      "INVALID_CONFIG",
    );
  }
  return parsed.origin;
}

export type BackendConfig = {
  assetsDir: string;
  authCookieSecure: boolean;
  authSessionTtlMs: number;
  bootstrapToken: string;
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
  loginAttemptLimit: number;
  loginWindowMs: number;
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
  const configuredBootstrapToken = environment.BACKEND_BOOTSTRAP_TOKEN?.trim();
  if (environment.NODE_ENV === "production" && !configuredBootstrapToken) {
    throw new BackendError(
      "BACKEND_BOOTSTRAP_TOKEN is required in production.",
      500,
      "INVALID_CONFIG",
    );
  }
  const bootstrapToken = configuredBootstrapToken
    || "local-development-bootstrap-token-change-me";
  if (bootstrapToken.length < 32 || Buffer.byteLength(bootstrapToken, "utf8") > 512) {
    throw new BackendError(
      "BACKEND_BOOTSTRAP_TOKEN must be between 32 and 512 bytes.",
      500,
      "INVALID_CONFIG",
    );
  }

  return {
    assetsDir: resolve(BACKEND_ROOT, "assets"),
    authCookieSecure: booleanValue(
      environment.BACKEND_AUTH_COOKIE_SECURE,
      environment.NODE_ENV === "production",
      "BACKEND_AUTH_COOKIE_SECURE",
    ),
    authSessionTtlMs: positiveInteger(
      environment.BACKEND_AUTH_SESSION_TTL_MS,
      7 * 24 * 60 * 60 * 1_000,
      "BACKEND_AUTH_SESSION_TTL_MS",
    ),
    bootstrapToken,
    corsOrigin: corsOrigin(environment.BACKEND_CORS_ORIGIN),
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
    loginAttemptLimit: positiveInteger(
      environment.BACKEND_LOGIN_ATTEMPT_LIMIT,
      5,
      "BACKEND_LOGIN_ATTEMPT_LIMIT",
    ),
    loginWindowMs: positiveInteger(
      environment.BACKEND_LOGIN_WINDOW_MS,
      15 * 60_000,
      "BACKEND_LOGIN_WINDOW_MS",
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
