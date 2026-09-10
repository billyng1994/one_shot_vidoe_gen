import { BackendError } from "./errors.js";
import { UUID_PATTERN, assertProjectId } from "./validation.js";

export const PROJECT_DOCUMENT_VERSION = 2 as const;
export const STUDIO_SNAPSHOT_VERSION = 1 as const;
export const LEGACY_PROJECT_ID = "legacy-v1";
export const MAX_PROJECTS_PER_OWNER = 50;

export type PersistedAsset = {
  requestId: string;
  url: string;
};

export type TitlePlacement = {
  text: string;
  x: number;
  y: number;
  fontSize: number;
};

export type StudioSnapshot = {
  version: 1;
  step: 1 | 2 | 3;
  imagePrompt: string;
  motionPrompt: string;
  image: PersistedAsset;
  video: PersistedAsset;
  duration: 5 | 8 | 10;
  resolution: "720" | "1080";
  cameraFixed: boolean;
  title: TitlePlacement;
  musicVolume: number;
};

export type StudioProject = {
  version: 2;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source?: "legacy-studio-v1";
  snapshot: StudioSnapshot;
};

const DEFAULT_TITLE: TitlePlacement = {
  text: "Your story starts here",
  x: 0.055,
  y: 0.165,
  fontSize: 86,
};

const REQUEST_ID_PATTERNS = {
  image: /^(?:(?:gen|cli)-image-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|demo-image-\d+)$/i,
  video: /^(?:(?:gen|cli)-video-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|demo-video-\d+)$/i,
} as const;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalid(message: string, code = "INVALID_PROJECT"): never {
  throw new BackendError(message, 400, code);
}

function parsedObject(value: unknown) {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedName(value: unknown, fallback = "Untitled project") {
  if (typeof value !== "string") return fallback;
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || fallback;
}

function isSafeMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizedRequestId(value: unknown, kind: "image" | "video") {
  return typeof value === "string" && REQUEST_ID_PATTERNS[kind].test(value) ? value : "";
}

function normalizedAsset(value: unknown, kind: "image" | "video"): PersistedAsset {
  const candidate = record(value);
  return {
    requestId: normalizedRequestId(candidate?.requestId, kind),
    url: isSafeMediaUrl(candidate?.url) ? candidate.url : "",
  };
}

function validateAsset(value: unknown, kind: "image" | "video"): PersistedAsset {
  const candidate = record(value);
  if (!candidate) invalid(`The ${kind} asset must be an object.`, "INVALID_PROJECT_SNAPSHOT");
  if (
    typeof candidate.requestId !== "string" ||
    (candidate.requestId !== "" && !REQUEST_ID_PATTERNS[kind].test(candidate.requestId))
  ) {
    invalid(`The ${kind} request ID is invalid.`, "INVALID_PROJECT_SNAPSHOT");
  }
  if (typeof candidate.url !== "string" || (candidate.url !== "" && !isSafeMediaUrl(candidate.url))) {
    invalid(`The ${kind} URL is invalid.`, "INVALID_PROJECT_SNAPSHOT");
  }
  return { requestId: candidate.requestId, url: candidate.url };
}

export function validateOwnerId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid("Invalid project owner ID.", "INVALID_OWNER_ID");
  }
  return value;
}

export function validateProjectId(value: unknown): string {
  assertProjectId(value);
  return value;
}

export function createEmptyStudioSnapshot(): StudioSnapshot {
  return {
    version: STUDIO_SNAPSHOT_VERSION,
    step: 1,
    imagePrompt: "",
    motionPrompt: "",
    image: { requestId: "", url: "" },
    video: { requestId: "", url: "" },
    duration: 5,
    resolution: "720",
    cameraFixed: false,
    title: { ...DEFAULT_TITLE },
    musicVolume: 0.24,
  };
}

/**
 * Strict validation for API input and durable records. The limits intentionally
 * match lib/studio-state.ts in the frontend.
 */
export function validateStudioSnapshot(value: unknown): StudioSnapshot {
  const candidate = record(value);
  if (!candidate || candidate.version !== STUDIO_SNAPSHOT_VERSION) {
    invalid("The project snapshot version is invalid.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (candidate.step !== 1 && candidate.step !== 2 && candidate.step !== 3) {
    invalid("The project step is invalid.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (typeof candidate.imagePrompt !== "string" || candidate.imagePrompt.length > 4_000) {
    invalid("The image prompt must be at most 4,000 characters.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (typeof candidate.motionPrompt !== "string" || candidate.motionPrompt.length > 4_000) {
    invalid("The motion prompt must be at most 4,000 characters.", "INVALID_PROJECT_SNAPSHOT");
  }

  const image = validateAsset(candidate.image, "image");
  const video = validateAsset(candidate.video, "video");
  if (!image.url && candidate.step !== 1) {
    invalid("A project without an image must be on step 1.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (candidate.step === 3 && !video.url) {
    invalid("A project on step 3 must have a video.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (candidate.duration !== 5 && candidate.duration !== 8 && candidate.duration !== 10) {
    invalid("The project duration must be 5, 8, or 10 seconds.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (candidate.resolution !== "720" && candidate.resolution !== "1080") {
    invalid("The project resolution must be 720 or 1080.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (typeof candidate.cameraFixed !== "boolean") {
    invalid("The camera-fixed setting must be a boolean.", "INVALID_PROJECT_SNAPSHOT");
  }

  const title = record(candidate.title);
  if (!title) invalid("The title placement must be an object.", "INVALID_PROJECT_SNAPSHOT");
  if (typeof title.text !== "string" || title.text.length > 180) {
    invalid("The title must be at most 180 characters.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (typeof title.x !== "number" || !Number.isFinite(title.x) || title.x < 0.02 || title.x > 0.82) {
    invalid("The title x position is out of range.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (typeof title.y !== "number" || !Number.isFinite(title.y) || title.y < 0.13 || title.y > 0.84) {
    invalid("The title y position is out of range.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (
    typeof title.fontSize !== "number" ||
    !Number.isFinite(title.fontSize) ||
    title.fontSize < 48 ||
    title.fontSize > 132
  ) {
    invalid("The title font size is out of range.", "INVALID_PROJECT_SNAPSHOT");
  }
  if (
    typeof candidate.musicVolume !== "number" ||
    !Number.isFinite(candidate.musicVolume) ||
    candidate.musicVolume < 0 ||
    candidate.musicVolume > 1
  ) {
    invalid("The music volume is out of range.", "INVALID_PROJECT_SNAPSHOT");
  }

  return {
    version: STUDIO_SNAPSHOT_VERSION,
    step: candidate.step,
    imagePrompt: candidate.imagePrompt,
    motionPrompt: candidate.motionPrompt,
    image,
    video,
    duration: candidate.duration,
    resolution: candidate.resolution,
    cameraFixed: candidate.cameraFixed,
    title: {
      text: title.text,
      x: title.x,
      y: title.y,
      fontSize: title.fontSize,
    },
    musicVolume: candidate.musicVolume,
  };
}

/**
 * Compatibility parser for objects read from the existing browser localStorage.
 * It deliberately mirrors the frontend's recovery/defaulting behaviour.
 */
export function normalizeLocalStudioSnapshot(value: unknown): StudioSnapshot {
  const candidate = parsedObject(value);
  if (!candidate || candidate.version !== STUDIO_SNAPSHOT_VERSION) {
    invalid("The imported project snapshot version is invalid.", "INVALID_PROJECT_IMPORT");
  }

  const image = normalizedAsset(candidate.image, "image");
  const video = normalizedAsset(candidate.video, "video");
  const title = record(candidate.title);
  const requestedStep = candidate.step === 2 || candidate.step === 3 ? candidate.step : 1;
  const step = !image.url ? 1 : requestedStep === 3 && !video.url ? 2 : requestedStep;

  return {
    version: STUDIO_SNAPSHOT_VERSION,
    step,
    imagePrompt: boundedString(candidate.imagePrompt, 4_000),
    motionPrompt: boundedString(candidate.motionPrompt, 4_000),
    image,
    video,
    duration: candidate.duration === 8 || candidate.duration === 10 ? candidate.duration : 5,
    resolution: candidate.resolution === "1080" ? "1080" : "720",
    cameraFixed: candidate.cameraFixed === true,
    title: {
      text: boundedString(title?.text, 180) || DEFAULT_TITLE.text,
      x: clamp(finiteNumber(title?.x, DEFAULT_TITLE.x), 0.02, 0.82),
      y: clamp(finiteNumber(title?.y, DEFAULT_TITLE.y), 0.13, 0.84),
      fontSize: clamp(finiteNumber(title?.fontSize, DEFAULT_TITLE.fontSize), 48, 132),
    },
    musicVolume: clamp(finiteNumber(candidate.musicVolume, 0.24), 0, 1),
  };
}

export function validateStudioProject(value: unknown, expectedId?: string): StudioProject {
  const candidate = parsedObject(value);
  if (!candidate || candidate.version !== PROJECT_DOCUMENT_VERSION) {
    invalid("The project document version is invalid.");
  }
  const id = validateProjectId(candidate.id);
  if (expectedId !== undefined && id !== expectedId) {
    invalid("The project document ID does not match.");
  }
  if (typeof candidate.name !== "string" || normalizedName(candidate.name) !== candidate.name) {
    invalid("The project name must contain 1 to 80 normalized characters.");
  }
  if (!validTimestamp(candidate.createdAt) || !validTimestamp(candidate.updatedAt)) {
    invalid("The project timestamps are invalid.");
  }
  if (candidate.source !== undefined && candidate.source !== "legacy-studio-v1") {
    invalid("The project source is invalid.");
  }

  return {
    version: PROJECT_DOCUMENT_VERSION,
    id,
    name: candidate.name,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    ...(candidate.source === "legacy-studio-v1" ? { source: candidate.source } : {}),
    snapshot: validateStudioSnapshot(candidate.snapshot),
  };
}

export function normalizeLocalStudioProject(value: unknown, expectedId?: string): StudioProject {
  const candidate = parsedObject(value);
  if (!candidate || candidate.version !== PROJECT_DOCUMENT_VERSION) {
    invalid("The imported project document version is invalid.", "INVALID_PROJECT_IMPORT");
  }

  let id: string;
  try {
    id = validateProjectId(candidate.id);
  } catch {
    invalid("The imported project ID is invalid.", "INVALID_PROJECT_IMPORT");
  }
  if (expectedId !== undefined && id !== expectedId) {
    invalid("The imported project ID does not match.", "INVALID_PROJECT_IMPORT");
  }

  const createdAt = validTimestamp(candidate.createdAt)
    ? candidate.createdAt as string
    : new Date(0).toISOString();
  const updatedAt = validTimestamp(candidate.updatedAt) ? candidate.updatedAt as string : createdAt;
  return {
    version: PROJECT_DOCUMENT_VERSION,
    id,
    name: normalizedName(candidate.name),
    createdAt,
    updatedAt,
    ...(candidate.source === "legacy-studio-v1"
      ? { source: "legacy-studio-v1" as const }
      : {}),
    snapshot: normalizeLocalStudioSnapshot(candidate.snapshot),
  };
}

export function normalizeProjectName(value: unknown, fallback = "Untitled project") {
  if (value !== undefined && typeof value !== "string") {
    invalid("The project name must be a string.");
  }
  return normalizedName(value, fallback);
}
