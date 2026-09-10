import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BackendError } from "./errors.js";
import {
  MAX_PROJECTS_PER_OWNER,
  PROJECT_DOCUMENT_VERSION,
  createEmptyStudioSnapshot,
  normalizeLocalStudioProject,
  normalizeProjectName,
  validateOwnerId,
  validateProjectId,
  validateStudioProject,
  validateStudioSnapshot,
  type StudioProject,
  type StudioSnapshot,
} from "./project-schema.js";

type ProjectEnvelope = {
  storageVersion: 1;
  ownerId: string;
  project: StudioProject;
};

export type CreateProjectInput = {
  id?: string;
  name?: string;
  snapshot?: StudioSnapshot;
  source?: "legacy-studio-v1";
};

export type UpdateProjectInput = {
  name?: string;
  snapshot?: StudioSnapshot;
};

export type LocalProjectImportResult = {
  created: number;
  updated: number;
  unchanged: number;
  projects: StudioProject[];
};

export type ProjectStoreOptions = {
  createId?: () => string;
  now?: () => Date | string;
};

function errno(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseEnvelope(value: unknown, ownerId: string, projectId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project envelope.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.storageVersion !== 1 || candidate.ownerId !== ownerId) {
    throw new Error("Invalid project envelope.");
  }
  return validateStudioProject(candidate.project, projectId);
}

function compareProjects(left: StudioProject, right: StudioProject) {
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated;
  const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return created || left.id.localeCompare(right.id);
}

function sameProject(left: StudioProject, right: StudioProject) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ProjectStore {
  private readonly projectsDirectory: string;
  private readonly createId: () => string;
  private readonly clock: () => Date | string;
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(dataDirectory: string, options: ProjectStoreOptions = {}) {
    this.projectsDirectory = join(dataDirectory, "projects");
    this.createId = options.createId ?? randomUUID;
    this.clock = options.now ?? (() => new Date());
  }

  async initialize() {
    await mkdir(this.projectsDirectory, { recursive: true, mode: 0o700 });
    const ownersByProject = new Map<string, string>();
    for (const ownerId of await this.ownerIds()) {
      for (const project of await this.listUnlocked(ownerId)) {
        const existingOwner = ownersByProject.get(project.id);
        if (existingOwner && existingOwner !== ownerId) {
          throw new BackendError(
            "A project ID is assigned to more than one owner.",
            500,
            "DUPLICATE_PROJECT_OWNER",
          );
        }
        ownersByProject.set(project.id, ownerId);
      }
    }
  }

  private ownerDirectory(ownerId: string) {
    return join(this.projectsDirectory, validateOwnerId(ownerId));
  }

  private projectPath(ownerId: string, projectId: string) {
    return join(this.ownerDirectory(ownerId), `${validateProjectId(projectId)}.json`);
  }

  private now() {
    const value = this.clock();
    const timestamp = value instanceof Date ? value.toISOString() : value;
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
      throw new BackendError("The project clock returned an invalid timestamp.", 500, "INVALID_CLOCK");
    }
    return timestamp;
  }

  private async serialize<T>(ownerId: string, operation: () => Promise<T>) {
    validateOwnerId(ownerId);
    // Project IDs are also media/job namespaces, so mutations are globally
    // serialized to keep each ID assigned to exactly one account.
    const lock = "project-catalog";
    const previous = this.mutations.get(lock) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.mutations.set(lock, current);
    try {
      return await current;
    } finally {
      if (this.mutations.get(lock) === current) {
        this.mutations.delete(lock);
      }
    }
  }

  private async ownerIds() {
    await mkdir(this.projectsDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.projectsDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((ownerId) => {
        try {
          validateOwnerId(ownerId);
          return true;
        } catch {
          return false;
        }
      });
  }

  private async projectOwner(projectId: string) {
    validateProjectId(projectId);
    let owner: string | undefined;
    for (const ownerId of await this.ownerIds()) {
      if (!await this.read(ownerId, projectId)) continue;
      if (owner && owner !== ownerId) {
        throw new BackendError(
          "A project ID is assigned to more than one owner.",
          500,
          "DUPLICATE_PROJECT_OWNER",
        );
      }
      owner = ownerId;
    }
    return owner;
  }

  private async read(ownerId: string, projectId: string) {
    const path = this.projectPath(ownerId, projectId);
    try {
      return parseEnvelope(JSON.parse(await readFile(path, "utf8")), ownerId, projectId);
    } catch (error) {
      if (errno(error, "ENOENT")) return undefined;
      throw new BackendError(
        "The project record could not be read.",
        500,
        "CORRUPT_PROJECT_RECORD",
      );
    }
  }

  private async listUnlocked(ownerId: string) {
    const directory = this.ownerDirectory(ownerId);
    let filenames: string[];
    try {
      filenames = await readdir(directory);
    } catch (error) {
      if (errno(error, "ENOENT")) return [];
      throw error;
    }

    const projects: StudioProject[] = [];
    for (const filename of filenames) {
      if (!filename.endsWith(".json") || filename.startsWith(".")) continue;
      const projectId = filename.slice(0, -5);
      try {
        validateProjectId(projectId);
      } catch {
        continue;
      }
      const project = await this.read(ownerId, projectId);
      if (project) projects.push(project);
    }
    return projects.sort(compareProjects);
  }

  private async atomicWrite(ownerId: string, project: StudioProject) {
    const validatedOwnerId = validateOwnerId(ownerId);
    const validatedProject = validateStudioProject(project, project.id);
    const directory = this.ownerDirectory(validatedOwnerId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = this.projectPath(validatedOwnerId, validatedProject.id);
    const temporary = join(directory, `.${validatedProject.id}.${randomUUID()}.tmp`);
    const envelope: ProjectEnvelope = {
      storageVersion: 1,
      ownerId: validatedOwnerId,
      project: validatedProject,
    };
    try {
      await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return validatedProject;
  }

  async list(ownerId: string) {
    validateOwnerId(ownerId);
    return this.listUnlocked(ownerId);
  }

  async get(ownerId: string, projectId: string) {
    validateOwnerId(ownerId);
    validateProjectId(projectId);
    const project = await this.read(ownerId, projectId);
    if (!project) {
      throw new BackendError("Project not found.", 404, "PROJECT_NOT_FOUND");
    }
    return project;
  }

  async create(ownerId: string, input: CreateProjectInput = {}) {
    return this.serialize(ownerId, async () => {
      const id = validateProjectId(input.id ?? this.createId());
      if (await this.projectOwner(id)) {
        throw new BackendError("The project already exists.", 409, "PROJECT_EXISTS");
      }
      const projects = await this.listUnlocked(ownerId);
      if (projects.length >= MAX_PROJECTS_PER_OWNER) {
        throw new BackendError(
          `An owner can have at most ${MAX_PROJECTS_PER_OWNER} projects.`,
          409,
          "PROJECT_LIMIT_REACHED",
        );
      }
      if (input.source !== undefined && input.source !== "legacy-studio-v1") {
        throw new BackendError("The project source is invalid.", 400, "INVALID_PROJECT");
      }
      const timestamp = this.now();
      return this.atomicWrite(ownerId, {
        version: PROJECT_DOCUMENT_VERSION,
        id,
        name: normalizeProjectName(input.name),
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.source ? { source: input.source } : {}),
        snapshot: input.snapshot === undefined
          ? createEmptyStudioSnapshot()
          : validateStudioSnapshot(input.snapshot),
      });
    });
  }

  async update(ownerId: string, projectId: string, input: UpdateProjectInput) {
    validateProjectId(projectId);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new BackendError("A project update object is required.", 400, "INVALID_PROJECT_UPDATE");
    }
    return this.serialize(ownerId, async () => {
      const current = await this.read(ownerId, projectId);
      if (!current) {
        throw new BackendError("Project not found.", 404, "PROJECT_NOT_FOUND");
      }
      const hasName = Object.prototype.hasOwnProperty.call(input, "name");
      const hasSnapshot = Object.prototype.hasOwnProperty.call(input, "snapshot");
      if (!hasName && !hasSnapshot) return current;

      const updated: StudioProject = {
        ...current,
        name: hasName ? normalizeProjectName(input.name, current.name) : current.name,
        snapshot: hasSnapshot ? validateStudioSnapshot(input.snapshot) : current.snapshot,
        updatedAt: this.now(),
      };
      return this.atomicWrite(ownerId, updated);
    });
  }

  /** Removes only the project document. Generated jobs and media remain untouched. */
  async delete(ownerId: string, projectId: string) {
    validateProjectId(projectId);
    return this.serialize(ownerId, async () => {
      const path = this.projectPath(ownerId, projectId);
      try {
        await rm(path);
        return true;
      } catch (error) {
        if (errno(error, "ENOENT")) return false;
        throw error;
      }
    });
  }

  async importLocalProjects(
    ownerId: string,
    values: unknown | readonly unknown[],
  ): Promise<LocalProjectImportResult> {
    const rawProjects = Array.isArray(values) ? values : [values];
    const importsById = new Map<string, StudioProject>();
    for (const rawProject of rawProjects) {
      const project = normalizeLocalStudioProject(rawProject);
      const previous = importsById.get(project.id);
      if (!previous || Date.parse(project.updatedAt) > Date.parse(previous.updatedAt)) {
        importsById.set(project.id, project);
      }
    }

    return this.serialize(ownerId, async () => {
      for (const projectId of importsById.keys()) {
        const currentOwner = await this.projectOwner(projectId);
        if (currentOwner && currentOwner !== ownerId) {
          throw new BackendError(
            "An imported project ID is already assigned to another account.",
            409,
            "PROJECT_ID_OWNED",
          );
        }
      }
      const existing = await this.listUnlocked(ownerId);
      const existingById = new Map(existing.map((project) => [project.id, project]));
      const newProjectCount = [...importsById.keys()].filter((id) => !existingById.has(id)).length;
      if (existing.length + newProjectCount > MAX_PROJECTS_PER_OWNER) {
        throw new BackendError(
          `An owner can have at most ${MAX_PROJECTS_PER_OWNER} projects.`,
          409,
          "PROJECT_LIMIT_REACHED",
        );
      }

      let created = 0;
      let updated = 0;
      let unchanged = 0;
      for (const project of importsById.values()) {
        const current = existingById.get(project.id);
        if (!current) {
          const stored = await this.atomicWrite(ownerId, project);
          existingById.set(stored.id, stored);
          created += 1;
        } else if (
          Date.parse(project.updatedAt) > Date.parse(current.updatedAt) &&
          !sameProject(project, current)
        ) {
          const stored = await this.atomicWrite(ownerId, project);
          existingById.set(stored.id, stored);
          updated += 1;
        } else {
          unchanged += 1;
        }
      }

      return {
        created,
        updated,
        unchanged,
        projects: [...existingById.values()].sort(compareProjects),
      };
    });
  }
}

/** Service-oriented name for route integration. */
export class ProjectService extends ProjectStore {}
