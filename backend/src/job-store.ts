import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BackendError } from "./errors.js";
import {
  assertProjectId,
  mediaUrl,
  parseBackendRequestId,
  parseMediaRelativePath,
  parseProviderRequestId,
  type GenerationKind,
} from "./validation.js";

export const GENERATION_STATUSES = [
  "queued",
  "in_progress",
  "nsfw",
  "failed",
  "completed",
  "canceled",
] as const;

export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export type StoredMedia = {
  bytes: number;
  contentType: string;
  relativePath: string;
};

export type GenerationJob = {
  version: 1;
  requestId: string;
  providerRequestId: string;
  projectId: string;
  kind: GenerationKind;
  prompt: string;
  status: GenerationStatus;
  createdAt: string;
  updatedAt: string;
  sourceImageRequestId?: string;
  videoOptions?: {
    cameraFixed: boolean;
    duration: number;
    resolution: "720" | "1080";
  };
  output?: StoredMedia;
  error?: string | null;
  lastPollError?: string;
};

const STATUS_SET = new Set<string>(GENERATION_STATUSES);

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseStoredMedia(value: unknown, projectId: string) {
  const parsed = record(value);
  if (!parsed) return undefined;
  const media = parseMediaRelativePath(parsed.relativePath);
  if (media.projectId !== projectId) {
    throw new BackendError("A job has an invalid media path.", 500, "CORRUPT_JOB_RECORD");
  }
  if (
    typeof parsed.bytes !== "number" ||
    !Number.isSafeInteger(parsed.bytes) ||
    parsed.bytes < 0 ||
    typeof parsed.contentType !== "string"
  ) {
    throw new BackendError("A job has invalid media metadata.", 500, "CORRUPT_JOB_RECORD");
  }
  return {
    bytes: parsed.bytes,
    contentType: parsed.contentType,
    relativePath: media.relativePath,
  } satisfies StoredMedia;
}

export function parseGenerationJob(value: unknown, expectedRequestId?: string): GenerationJob {
  const parsed = record(value);
  if (!parsed || parsed.version !== 1) {
    throw new BackendError("The generation record is invalid.", 500, "CORRUPT_JOB_RECORD");
  }
  const request = parseBackendRequestId(parsed.requestId);
  if (expectedRequestId && request.requestId !== expectedRequestId) {
    throw new BackendError("The generation record ID does not match.", 500, "CORRUPT_JOB_RECORD");
  }
  const provider = parseProviderRequestId(parsed.providerRequestId);
  if (request.kind !== provider.kind || parsed.kind !== request.kind) {
    throw new BackendError("The generation record kind does not match.", 500, "CORRUPT_JOB_RECORD");
  }
  assertProjectId(parsed.projectId);
  if (
    typeof parsed.prompt !== "string" ||
    !STATUS_SET.has(String(parsed.status)) ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    typeof parsed.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.updatedAt))
  ) {
    throw new BackendError("The generation record is incomplete.", 500, "CORRUPT_JOB_RECORD");
  }

  if (parsed.sourceImageRequestId !== undefined) {
    const source = parseBackendRequestId(parsed.sourceImageRequestId);
    if (source.kind !== "image") {
      throw new BackendError("The source generation is invalid.", 500, "CORRUPT_JOB_RECORD");
    }
  }

  const options = record(parsed.videoOptions);
  const videoOptions = options
    ? {
        cameraFixed: options.cameraFixed === true,
        duration: Number(options.duration),
        resolution: options.resolution as "720" | "1080",
      }
    : undefined;
  if (
    videoOptions &&
    (!Number.isInteger(videoOptions.duration) ||
      videoOptions.duration < 2 ||
      videoOptions.duration > 12 ||
      !["720", "1080"].includes(videoOptions.resolution))
  ) {
    throw new BackendError("The stored video options are invalid.", 500, "CORRUPT_JOB_RECORD");
  }

  return {
    version: 1,
    requestId: request.requestId,
    providerRequestId: provider.requestId,
    projectId: parsed.projectId,
    kind: request.kind,
    prompt: parsed.prompt,
    status: parsed.status as GenerationStatus,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    ...(typeof parsed.sourceImageRequestId === "string"
      ? { sourceImageRequestId: parsed.sourceImageRequestId }
      : {}),
    ...(videoOptions ? { videoOptions } : {}),
    ...(parsed.output ? { output: parseStoredMedia(parsed.output, parsed.projectId) } : {}),
    ...(typeof parsed.error === "string" || parsed.error === null
      ? { error: parsed.error }
      : {}),
    ...(typeof parsed.lastPollError === "string"
      ? { lastPollError: parsed.lastPollError.slice(0, 400) }
      : {}),
  };
}

export function publicGeneration(job: GenerationJob) {
  const response: {
    status: GenerationStatus;
    request_id: string;
    error?: string | null;
    images?: Array<{ url: string }>;
    video?: { url: string };
  } = {
    status: job.status,
    request_id: job.requestId,
    ...(job.error ? { error: job.error } : {}),
  };

  if (job.status === "completed" && job.output) {
    const url = mediaUrl(job.output.relativePath);
    if (job.kind === "image") response.images = [{ url }];
    else response.video = { url };
  }

  return response;
}

export class JobStore {
  private readonly jobsDirectory: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDirectory: string) {
    this.jobsDirectory = join(dataDirectory, "jobs");
  }

  async initialize() {
    await mkdir(this.jobsDirectory, { recursive: true });
  }

  private jobPath(requestId: string) {
    parseBackendRequestId(requestId);
    return join(this.jobsDirectory, `${requestId}.json`);
  }

  private async atomicWrite(job: GenerationJob) {
    const parsed = parseGenerationJob(job, job.requestId);
    await this.initialize();
    const destination = this.jobPath(parsed.requestId);
    const temporary = join(this.jobsDirectory, `.${parsed.requestId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return parsed;
  }

  async create(job: GenerationJob) {
    try {
      await readFile(this.jobPath(job.requestId));
      throw new BackendError("The generation request already exists.", 409, "JOB_EXISTS");
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.atomicWrite(job);
  }

  async read(requestId: string) {
    const path = this.jobPath(requestId);
    try {
      return parseGenerationJob(JSON.parse(await readFile(path, "utf8")), requestId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BackendError("Generation request not found.", 404, "JOB_NOT_FOUND");
      }
      if (error instanceof BackendError) throw error;
      throw new BackendError("The generation record could not be read.", 500, "CORRUPT_JOB_RECORD");
    }
  }

  async update(requestId: string, update: (job: GenerationJob) => GenerationJob | Promise<GenerationJob>) {
    const previous = this.locks.get(requestId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const current = await this.read(requestId);
      return this.atomicWrite(await update(current));
    });
    this.locks.set(requestId, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(requestId) === operation) this.locks.delete(requestId);
    }
  }

  async list() {
    await this.initialize();
    const filenames = await readdir(this.jobsDirectory);
    const jobs: GenerationJob[] = [];
    for (const filename of filenames) {
      if (!filename.endsWith(".json")) continue;
      const requestId = filename.slice(0, -5);
      try {
        parseBackendRequestId(requestId);
        jobs.push(await this.read(requestId));
      } catch {
        // A corrupt record must not prevent other durable jobs from resuming.
      }
    }
    return jobs;
  }

  async deleteProject(projectId: string) {
    assertProjectId(projectId);
    const jobs = await this.list();
    const projectJobs = jobs.filter((job) => job.projectId === projectId);
    await Promise.all(
      projectJobs.map((job) => rm(this.jobPath(job.requestId), { force: true })),
    );
    return projectJobs.length;
  }
}
