import {
  parseStudioSnapshot,
  serializeStudioSnapshot,
  STUDIO_STORAGE_KEY,
  type StudioSnapshot,
} from "./studio-state";
import { DEFAULT_TITLE } from "./composition";

export const PROJECT_INDEX_STORAGE_KEY = "onetake:studio:v2:index";
export const PROJECT_STORAGE_PREFIX = "onetake:studio:v2:project:";
export const LEGACY_PROJECT_ID = "legacy-v1";

const PROJECT_VERSION = 2;
const MAX_PROJECTS = 50;
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

export type ProjectIndex = {
  version: 2;
  projectIds: string[];
  lastProjectId: string;
  migrations: {
    legacyStudioV1: boolean;
  };
};

export type ProjectCollection = {
  projects: StudioProject[];
  activeProjectId: string;
};

type StorageReader = Pick<Storage, "getItem" | "key" | "length">;
type StorageWriter = Pick<Storage, "getItem" | "key" | "length" | "setItem" | "removeItem">;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validTimestamp(value: unknown, fallback: string) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function projectName(value: unknown, fallback = "Untitled project") {
  if (typeof value !== "string") return fallback;
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || fallback;
}

function safeGet(storage: Pick<Storage, "getItem">, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function isProjectId(value: unknown): value is string {
  return value === LEGACY_PROJECT_ID ||
    (typeof value === "string" && PROJECT_ID_PATTERN.test(value));
}

export function projectStorageKey(projectId: string) {
  if (!isProjectId(projectId)) throw new Error("Invalid project ID.");
  return `${PROJECT_STORAGE_PREFIX}${projectId}`;
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

export function createStudioProject(
  name: string,
  options: {
    id?: string;
    now?: string;
    snapshot?: StudioSnapshot;
    source?: "legacy-studio-v1";
  } = {},
): StudioProject {
  const id = options.id ?? crypto.randomUUID();
  if (!isProjectId(id)) throw new Error("Invalid project ID.");
  const now = validTimestamp(options.now, new Date().toISOString());

  return {
    version: PROJECT_VERSION,
    id,
    name: projectName(name),
    createdAt: now,
    updatedAt: now,
    ...(options.source ? { source: options.source } : {}),
    snapshot: options.snapshot ?? createEmptyStudioSnapshot(),
  };
}

export function parseStudioProject(
  value: string | null,
  expectedId?: string,
): StudioProject | null {
  if (!value) return null;

  try {
    const parsed = record(JSON.parse(value));
    if (!parsed || parsed.version !== PROJECT_VERSION || !isProjectId(parsed.id)) return null;
    if (expectedId && parsed.id !== expectedId) return null;

    const snapshot = parseStudioSnapshot(JSON.stringify(parsed.snapshot));
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
  } catch {
    return null;
  }
}

export function serializeStudioProject(project: StudioProject) {
  return JSON.stringify(project);
}

export function parseProjectIndex(value: string | null): ProjectIndex | null {
  if (!value) return null;

  try {
    const parsed = record(JSON.parse(value));
    if (!parsed || parsed.version !== PROJECT_VERSION || !Array.isArray(parsed.projectIds)) {
      return null;
    }

    const projectIds = [...new Set(parsed.projectIds.filter(isProjectId))].slice(0, MAX_PROJECTS);
    if (projectIds.length === 0) return null;
    const migrations = record(parsed.migrations);
    const lastProjectId = projectIds.includes(String(parsed.lastProjectId))
      ? String(parsed.lastProjectId)
      : projectIds[0];

    return {
      version: PROJECT_VERSION,
      projectIds,
      lastProjectId,
      migrations: { legacyStudioV1: migrations?.legacyStudioV1 === true },
    };
  } catch {
    return null;
  }
}

export function saveStudioProject(storage: Pick<Storage, "setItem">, project: StudioProject) {
  try {
    storage.setItem(projectStorageKey(project.id), serializeStudioProject(project));
    return true;
  } catch {
    return false;
  }
}

export function removeStudioProject(storage: Pick<Storage, "removeItem">, projectId: string) {
  try {
    storage.removeItem(projectStorageKey(projectId));
    return true;
  } catch {
    return false;
  }
}

export function saveProjectIndex(
  storage: Pick<Storage, "setItem">,
  projects: StudioProject[],
  activeProjectId: string,
) {
  const projectIds = projects.map((project) => project.id).filter(isProjectId).slice(0, MAX_PROJECTS);
  if (projectIds.length === 0) return false;
  const lastProjectId = projectIds.includes(activeProjectId) ? activeProjectId : projectIds[0];
  const index: ProjectIndex = {
    version: PROJECT_VERSION,
    projectIds,
    lastProjectId,
    migrations: { legacyStudioV1: true },
  };

  try {
    storage.setItem(PROJECT_INDEX_STORAGE_KEY, JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

export function readStudioProject(storage: Pick<Storage, "getItem">, projectId: string) {
  if (!isProjectId(projectId)) return null;
  return parseStudioProject(safeGet(storage, projectStorageKey(projectId)), projectId);
}

function scanProjects(storage: StorageReader) {
  const projects = new Map<string, StudioProject>();

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(PROJECT_STORAGE_PREFIX)) continue;
      const id = key.slice(PROJECT_STORAGE_PREFIX.length);
      if (!isProjectId(id)) continue;
      const project = parseStudioProject(safeGet(storage, key), id);
      if (project) projects.set(project.id, project);
    }
  } catch {
    // A valid index can still be used when key enumeration is unavailable.
  }

  return projects;
}

export function initializeProjectStorage(
  storage: StorageWriter,
  options: { id?: string; now?: string } = {},
): ProjectCollection {
  const index = parseProjectIndex(safeGet(storage, PROJECT_INDEX_STORAGE_KEY));
  const projectsById = scanProjects(storage);

  for (const id of index?.projectIds ?? []) {
    if (projectsById.has(id)) continue;
    const project = readStudioProject(storage, id);
    if (project) projectsById.set(id, project);
  }

  const legacyValue = safeGet(storage, STUDIO_STORAGE_KEY);
  const legacySnapshot = parseStudioSnapshot(legacyValue);
  if (legacySnapshot && !projectsById.has(LEGACY_PROJECT_ID)) {
    const legacyProject = createStudioProject("My first project", {
      id: LEGACY_PROJECT_ID,
      now: options.now,
      snapshot: legacySnapshot,
      source: "legacy-studio-v1",
    });
    if (saveStudioProject(storage, legacyProject)) {
      projectsById.set(legacyProject.id, legacyProject);
    }
  }

  if (projectsById.size === 0) {
    const project = createStudioProject("Untitled project", {
      id: options.id,
      now: options.now,
    });
    saveStudioProject(storage, project);
    projectsById.set(project.id, project);
  }

  const orderedIds = [
    ...(index?.projectIds ?? []),
    ...projectsById.keys(),
  ].filter((id, position, all) => projectsById.has(id) && all.indexOf(id) === position);
  const projects = orderedIds
    .map((id) => projectsById.get(id))
    .filter((project): project is StudioProject => Boolean(project))
    .slice(0, MAX_PROJECTS);
  const activeProjectId = projects.some((project) => project.id === index?.lastProjectId)
    ? String(index?.lastProjectId)
    : projects[0].id;

  const indexSaved = saveProjectIndex(storage, projects, activeProjectId);
  if (legacySnapshot && projects.some((project) => project.id === LEGACY_PROJECT_ID) && indexSaved) {
    try {
      storage.removeItem(STUDIO_STORAGE_KEY);
    } catch {
      // Retaining the legacy value is safer than risking data loss.
    }
  }

  return { projects, activeProjectId };
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
