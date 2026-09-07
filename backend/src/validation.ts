import { posix } from "node:path";

import { BackendError } from "./errors.js";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID_PATTERN =
  /^(?:legacy-v1|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const BACKEND_REQUEST_PATTERN =
  /^gen-(image|video)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const PROVIDER_REQUEST_PATTERN =
  /^cli-(image|video)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SAFE_FILENAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const MEDIA_CATEGORIES = new Set(["images", "videos", "renders"]);

export type GenerationKind = "image" | "video";

export function assertProjectId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) {
    throw new BackendError("Invalid project ID.", 400, "INVALID_PROJECT_ID");
  }
}

export function parseBackendRequestId(value: unknown) {
  if (typeof value !== "string") {
    throw new BackendError("Invalid generation request ID.", 400, "INVALID_REQUEST_ID");
  }
  const match = BACKEND_REQUEST_PATTERN.exec(value);
  if (!match) {
    throw new BackendError("Invalid generation request ID.", 400, "INVALID_REQUEST_ID");
  }
  return { requestId: value, kind: match[1]!.toLowerCase() as GenerationKind, id: match[2]! };
}

export function parseProviderRequestId(value: unknown) {
  if (typeof value !== "string") {
    throw new BackendError("Invalid provider request ID.", 500, "CORRUPT_JOB_RECORD");
  }
  const match = PROVIDER_REQUEST_PATTERN.exec(value);
  if (!match) {
    throw new BackendError("Invalid provider request ID.", 500, "CORRUPT_JOB_RECORD");
  }
  return { requestId: value, kind: match[1]!.toLowerCase() as GenerationKind, id: match[2]! };
}

export function createBackendRequestId(kind: GenerationKind, id = crypto.randomUUID()) {
  if (!UUID_PATTERN.test(id)) {
    throw new BackendError("Could not create a generation request ID.", 500, "INVALID_UUID");
  }
  return `gen-${kind}-${id}`;
}

export function assertSafeFilename(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !SAFE_FILENAME_PATTERN.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new BackendError("Invalid media filename.", 400, "INVALID_MEDIA_PATH");
  }
}

export function mediaRelativePath(
  projectId: string,
  category: "images" | "videos" | "renders",
  filename: string,
) {
  assertProjectId(projectId);
  assertSafeFilename(filename);
  return posix.join(projectId, category, filename);
}

export function mediaUrl(relativePath: string) {
  const parsed = parseMediaRelativePath(relativePath);
  return `/media/${parsed.projectId}/${parsed.category}/${parsed.filename}`;
}

export function parseMediaRelativePath(value: unknown) {
  if (typeof value !== "string" || value.includes("\\") || value.includes("%")) {
    throw new BackendError("Invalid media path.", 400, "INVALID_MEDIA_PATH");
  }
  const segments = value.split("/");
  if (segments.length !== 3 || !MEDIA_CATEGORIES.has(segments[1]!)) {
    throw new BackendError("Invalid media path.", 400, "INVALID_MEDIA_PATH");
  }
  const [projectId, category, filename] = segments;
  assertProjectId(projectId!);
  assertSafeFilename(filename!);
  return {
    projectId,
    category: category as "images" | "videos" | "renders",
    filename,
    relativePath: `${projectId}/${category}/${filename}`,
  };
}

export function parseLocalMediaUrl(value: unknown, expectedProjectId?: string) {
  if (
    typeof value !== "string" ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    !value.startsWith("/media/")
  ) {
    throw new BackendError(
      "Only backend-managed media can be used.",
      400,
      "INVALID_MEDIA_URL",
    );
  }
  const parsed = parseMediaRelativePath(value.slice("/media/".length));
  if (expectedProjectId && parsed.projectId !== expectedProjectId) {
    throw new BackendError(
      "The media does not belong to this project.",
      400,
      "MEDIA_PROJECT_MISMATCH",
    );
  }
  return parsed;
}

export function validatePrompt(value: unknown, label: string) {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (prompt.length < 3 || prompt.length > 4_000) {
    throw new BackendError(
      `${label} must be between 3 and 4,000 characters.`,
      400,
      "INVALID_PROMPT",
    );
  }
  return prompt;
}
