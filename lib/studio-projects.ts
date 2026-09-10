import { DEFAULT_TITLE } from "./composition";
import {
  parseStudioSnapshot,
  serializeStudioSnapshot,
  type StudioSnapshot,
} from "./studio-state";

export const LEGACY_PROJECT_ID = "legacy-v1";

const PROJECT_VERSION = 2;
const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StudioProject = {
  version: 2;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source?: "legacy-studio-v1";
  snapshot: StudioSnapshot;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsedRecord(value: unknown) {
  if (typeof value !== "string") return record(value);

  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function validTimestamp(value: unknown, fallback: string) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function projectName(value: unknown, fallback = "Untitled project") {
  if (typeof value !== "string") return fallback;
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || fallback;
}

export function isProjectId(value: unknown): value is string {
  return value === LEGACY_PROJECT_ID ||
    (typeof value === "string" && PROJECT_ID_PATTERN.test(value));
}

export function createEmptyStudioSnapshot(): StudioSnapshot {
  return {
    version: 1,
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
 * Parses an untrusted project returned by the backend. JSON strings remain
 * accepted so imports and durable records can share this validation path.
 */
export function parseStudioProject(
  value: unknown,
  expectedId?: string,
): StudioProject | null {
  const parsed = parsedRecord(value);
  if (!parsed || parsed.version !== PROJECT_VERSION || !isProjectId(parsed.id)) return null;
  if (expectedId && parsed.id !== expectedId) return null;

  let serializedSnapshot: string;
  try {
    serializedSnapshot = JSON.stringify(parsed.snapshot);
  } catch {
    return null;
  }
  const snapshot = parseStudioSnapshot(serializedSnapshot);
  if (!snapshot) return null;
  const createdAt = validTimestamp(parsed.createdAt, new Date(0).toISOString());

  return {
    version: PROJECT_VERSION,
    id: parsed.id,
    name: projectName(parsed.name),
    createdAt,
    updatedAt: validTimestamp(parsed.updatedAt, createdAt),
    ...(parsed.source === "legacy-studio-v1"
      ? { source: "legacy-studio-v1" as const }
      : {}),
    snapshot,
  };
}

export function updateProjectSnapshot(
  project: StudioProject,
  snapshot: StudioSnapshot,
  now = new Date().toISOString(),
): StudioProject {
  return {
    ...project,
    updatedAt: validTimestamp(now, new Date().toISOString()),
    snapshot: parseStudioSnapshot(serializeStudioSnapshot(snapshot)) ?? createEmptyStudioSnapshot(),
  };
}

export function renameStudioProject(
  project: StudioProject,
  name: string,
  now = new Date().toISOString(),
): StudioProject {
  return {
    ...project,
    name: projectName(name, project.name),
    updatedAt: validTimestamp(now, new Date().toISOString()),
  };
}
