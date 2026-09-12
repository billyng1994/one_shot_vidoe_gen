import { randomUUID } from "node:crypto";

import { BackendError } from "./errors.js";
import {
  findRecentHiggsfieldImage,
  findRecentHiggsfieldVideo,
  getHiggsfieldCliHealth,
  getHiggsfieldGeneration,
  getImageModel,
  getModelLabel,
  getVideoModel,
  submitHiggsfieldImage,
  submitHiggsfieldVideo,
  type GenerationRequest as ProviderGeneration,
  type VideoGenerationInput,
} from "./higgsfield.js";
import {
  type GenerationJob,
  type GenerationStatus,
  type JobStore,
  publicGeneration,
} from "./job-store.js";
import type { MediaStorage } from "./media-storage.js";
import { Semaphore } from "./semaphore.js";
import {
  assertProjectId,
  createBackendRequestId,
  parseBackendRequestId,
  parseProviderRequestId,
} from "./validation.js";

const TERMINAL_STATUSES = new Set<GenerationStatus>([
  "completed",
  "failed",
  "nsfw",
  "canceled",
]);

export type ProviderAdapter = {
  findRecentImage(prompt: string, signal?: AbortSignal): Promise<ProviderGeneration | undefined>;
  findRecentVideo(input: VideoGenerationInput, signal?: AbortSignal): Promise<ProviderGeneration | undefined>;
  getGeneration(requestId: string, signal?: AbortSignal): Promise<ProviderGeneration>;
  health(): ReturnType<typeof getHiggsfieldCliHealth>;
  imageModel(): string;
  submitImage(prompt: string, signal?: AbortSignal): Promise<ProviderGeneration>;
  submitVideo(input: VideoGenerationInput, signal?: AbortSignal): Promise<ProviderGeneration>;
  videoModel(): string;
};

const defaultProvider: ProviderAdapter = {
  findRecentImage: (prompt, signal) => findRecentHiggsfieldImage(prompt, { signal }),
  findRecentVideo: (input, signal) => findRecentHiggsfieldVideo(input, { signal }),
  getGeneration: (requestId, signal) => getHiggsfieldGeneration(requestId, { signal }),
  health: () => getHiggsfieldCliHealth(),
  imageModel: () => getImageModel(),
  submitImage: (prompt, signal) => submitHiggsfieldImage(prompt, { signal }),
  submitVideo: (input, signal) => submitHiggsfieldVideo(input, { signal }),
  videoModel: () => getVideoModel(),
};

type ServiceOptions = {
  cliConcurrency: number;
  mockMode: boolean;
  pollInitialDelayMs: number;
  pollMaxDelayMs: number;
  pollWindowMs: number;
};

type Logger = Pick<Console, "error" | "warn">;

function defaultSleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function providerStatusForStorage(status: GenerationStatus) {
  return status === "completed" ? "in_progress" : status;
}

function cleanInternalError(error: unknown) {
  const message = error instanceof Error ? error.message : "Provider status refresh failed.";
  return message.replace(/\s+/g, " ").trim().slice(0, 400);
}

function isLegacyStatusFailure(job: GenerationJob) {
  return job.status === "failed" && job.error === undefined && job.output === undefined;
}

export class GenerationService {
  private readonly cli: Semaphore;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly workerControllers = new Map<string, AbortController>();
  private readonly submissions = new Map<string, Promise<unknown>>();
  private readonly deletingProjects = new Map<string, Promise<number>>();
  private readonly projectEpochs = new Map<string, number>();

  constructor(
    private readonly jobs: JobStore,
    private readonly media: MediaStorage,
    private readonly options: ServiceOptions,
    private readonly provider: ProviderAdapter = defaultProvider,
    private readonly logger: Logger = console,
    private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ) {
    this.cli = new Semaphore(options.cliConcurrency);
  }

  async initialize() {
    await Promise.all([this.jobs.initialize(), this.media.initialize()]);
    await this.resumePendingJobs();
  }

  async health() {
    const [cli, writable] = await Promise.all([
      this.options.mockMode
        ? Promise.resolve({ installed: true, authenticated: true, version: "demo" })
        : this.provider.health(),
      this.media.writable(),
    ]);
    const imageModel = this.provider.imageModel();
    const videoModel = this.provider.videoModel();
    return {
      configured: writable && (this.options.mockMode || (cli.installed && cli.authenticated)),
      mockMode: this.options.mockMode,
      provider: "Higgsfield CLI",
      storage: { writable },
      cli,
      models: {
        image: getModelLabel(imageModel),
        video: getModelLabel(videoModel),
      },
    };
  }

  private serializeSubmission<T>(key: string, task: () => Promise<T>) {
    const previous = this.submissions.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    this.submissions.set(key, operation);
    return operation.finally(() => {
      if (this.submissions.get(key) === operation) this.submissions.delete(key);
    });
  }

  private buildJob(input: {
    kind: "image" | "video";
    projectId: string;
    prompt: string;
    providerResult: ProviderGeneration;
    sourceImageRequestId?: string;
    videoOptions?: GenerationJob["videoOptions"];
  }) {
    const providerRequest = parseProviderRequestId(input.providerResult.request_id);
    if (providerRequest.kind !== input.kind) {
      throw new BackendError("The provider returned the wrong job kind.", 502, "PROVIDER_KIND_MISMATCH");
    }
    const now = new Date().toISOString();
    return {
      version: 1,
      requestId: createBackendRequestId(input.kind),
      providerRequestId: providerRequest.requestId,
      projectId: input.projectId,
      kind: input.kind,
      prompt: input.prompt,
      status: providerStatusForStorage(input.providerResult.status),
      createdAt: now,
      updatedAt: now,
      ...(input.sourceImageRequestId
        ? { sourceImageRequestId: input.sourceImageRequestId }
        : {}),
      ...(input.videoOptions ? { videoOptions: input.videoOptions } : {}),
      ...(input.providerResult.error ? { error: input.providerResult.error } : {}),
    } satisfies GenerationJob;
  }

  private buildMockProviderResult(kind: "image" | "video"): ProviderGeneration {
    return {
      status: "queued",
      request_id: `cli-${kind}-${randomUUID()}`,
    };
  }

  async createImage(projectId: string, prompt: string) {
    assertProjectId(projectId);
    return this.serializeSubmission(`image\0${projectId}\0${prompt}`, async () => {
      if (this.deletingProjects.has(projectId)) {
        throw new BackendError("Project media is being deleted.", 409, "PROJECT_DELETE_IN_PROGRESS");
      }
      const projectEpoch = this.projectEpochs.get(projectId) ?? 0;
      const providerResult = this.options.mockMode
        ? this.buildMockProviderResult("image")
        : await this.cli.use(async () =>
            (await this.provider.findRecentImage(prompt)) ?? this.provider.submitImage(prompt),
          );
      if (
        this.deletingProjects.has(projectId) ||
        (this.projectEpochs.get(projectId) ?? 0) !== projectEpoch
      ) {
        throw new BackendError("Project media was deleted during generation.", 409, "PROJECT_DELETED");
      }
      const job = await this.jobs.create(
        this.buildJob({ kind: "image", projectId, prompt, providerResult }),
      );
      this.enqueue(job.requestId);
      return publicGeneration(job);
    });
  }

  async createVideo(input: {
    cameraFixed: boolean;
    duration: number;
    imageRequestId: string;
    projectId: string;
    prompt: string;
    resolution: "720" | "1080";
  }) {
    assertProjectId(input.projectId);
    if (this.deletingProjects.has(input.projectId)) {
      throw new BackendError("Project media is being deleted.", 409, "PROJECT_DELETE_IN_PROGRESS");
    }
    const sourceRequest = parseBackendRequestId(input.imageRequestId);
    if (sourceRequest.kind !== "image") {
      throw new BackendError("The first-frame job must be an image generation.", 400, "INVALID_SOURCE_JOB");
    }
    const source = await this.jobs.read(sourceRequest.requestId);
    if (source.projectId !== input.projectId) {
      throw new BackendError(
        "The first-frame job does not belong to this project.",
        400,
        "SOURCE_PROJECT_MISMATCH",
      );
    }
    if (source.kind !== "image" || source.status !== "completed" || !source.output) {
      throw new BackendError("The first-frame image job is not completed.", 409, "SOURCE_NOT_READY");
    }
    await this.media.resolveFile(source.output.relativePath);

    const videoInput: VideoGenerationInput = {
      cameraFixed: input.cameraFixed,
      duration: input.duration,
      imageRequestId: source.providerRequestId,
      prompt: input.prompt,
      resolution: input.resolution,
    };
    return this.serializeSubmission(
      `video\0${input.projectId}\0${source.providerRequestId}\0${JSON.stringify(videoInput)}`,
      async () => {
        if (this.deletingProjects.has(input.projectId)) {
          throw new BackendError("Project media is being deleted.", 409, "PROJECT_DELETE_IN_PROGRESS");
        }
        const projectEpoch = this.projectEpochs.get(input.projectId) ?? 0;
        const providerResult = this.options.mockMode
          ? this.buildMockProviderResult("video")
          : await this.cli.use(async () =>
              (await this.provider.findRecentVideo(videoInput)) ??
              this.provider.submitVideo(videoInput),
            );
        if (
          this.deletingProjects.has(input.projectId) ||
          (this.projectEpochs.get(input.projectId) ?? 0) !== projectEpoch
        ) {
          throw new BackendError("Project media was deleted during generation.", 409, "PROJECT_DELETED");
        }
        const job = await this.jobs.create(
          this.buildJob({
            kind: "video",
            projectId: input.projectId,
            prompt: input.prompt,
            providerResult,
            sourceImageRequestId: source.requestId,
            videoOptions: {
              cameraFixed: input.cameraFixed,
              duration: input.duration,
              resolution: input.resolution,
            },
          }),
        );
        this.enqueue(job.requestId);
        return publicGeneration(job);
      },
    );
  }

  async get(requestId: string) {
    parseBackendRequestId(requestId);
    const job = await this.jobs.read(requestId);
    const recheckLegacyFailure = !this.options.mockMode && isLegacyStatusFailure(job);
    if (
      (!TERMINAL_STATUSES.has(job.status) || recheckLegacyFailure) &&
      !this.deletingProjects.has(job.projectId)
    ) {
      this.enqueue(job.requestId, recheckLegacyFailure);
    }
    return publicGeneration(
      recheckLegacyFailure && this.workers.has(job.requestId)
        ? { ...job, status: "in_progress" }
        : job,
    );
  }

  async resumePendingJobs() {
    const jobs = await this.jobs.list();
    for (const job of jobs) {
      const recheckLegacyFailure = !this.options.mockMode && isLegacyStatusFailure(job);
      if (!TERMINAL_STATUSES.has(job.status) || recheckLegacyFailure) {
        this.enqueue(job.requestId, recheckLegacyFailure);
      }
    }
  }

  async deleteProject(projectId: string) {
    assertProjectId(projectId);
    const existing = this.deletingProjects.get(projectId);
    if (existing) return existing;
    const operation = (async () => {
      this.projectEpochs.set(projectId, (this.projectEpochs.get(projectId) ?? 0) + 1);
      const projectJobs = (await this.jobs.list()).filter((job) => job.projectId === projectId);
      const activeWorkers = projectJobs.flatMap((job) => {
        this.workerControllers.get(job.requestId)?.abort();
        const worker = this.workers.get(job.requestId);
        return worker ? [worker] : [];
      });
      await Promise.allSettled(activeWorkers);
      const deletedJobs = await this.jobs.deleteProject(projectId);
      await this.media.deleteProject(projectId);
      return deletedJobs;
    })();
    this.deletingProjects.set(projectId, operation);
    try {
      return await operation;
    } finally {
      if (this.deletingProjects.get(projectId) === operation) {
        this.deletingProjects.delete(projectId);
      }
    }
  }

  private enqueue(requestId: string, recheckLegacyFailure = false) {
    if (this.workers.has(requestId)) return;
    const controller = new AbortController();
    this.workerControllers.set(requestId, controller);
    const worker = this.runWorker(requestId, controller.signal, recheckLegacyFailure)
      .catch((error) => {
        this.logger.error(`Generation worker ${requestId} stopped: ${cleanInternalError(error)}`);
      })
      .finally(() => {
        if (this.workers.get(requestId) === worker) this.workers.delete(requestId);
        if (this.workerControllers.get(requestId) === controller) {
          this.workerControllers.delete(requestId);
        }
      });
    this.workers.set(requestId, worker);
  }

  private async runWorker(
    requestId: string,
    signal: AbortSignal,
    recheckLegacyFailure = false,
  ) {
    const deadline = Date.now() + this.options.pollWindowMs;
    let delay = 0;

    while (Date.now() <= deadline) {
      if (delay > 0) await this.sleep(delay, signal);
      if (signal.aborted) return;
      let job: GenerationJob;
      try {
        job = await this.jobs.read(requestId);
      } catch (error) {
        if (error instanceof BackendError && error.status === 404) return;
        throw error;
      }
      if (
        TERMINAL_STATUSES.has(job.status) &&
        !(recheckLegacyFailure && isLegacyStatusFailure(job))
      ) return;

      try {
        const refreshed = await this.refresh(job, signal);
        if (TERMINAL_STATUSES.has(refreshed.status)) return;
      } catch (error) {
        const message = cleanInternalError(error);
        this.logger.warn(`Generation worker ${requestId} will retry: ${message}`);
        await this.jobs.update(requestId, (current) => ({
          ...current,
          lastPollError: message,
          updatedAt: new Date().toISOString(),
        })).catch(() => undefined);
      }
      delay = delay === 0
        ? this.options.pollInitialDelayMs
        : Math.min(Math.round(delay * 1.35), this.options.pollMaxDelayMs);
    }

    await this.jobs.update(requestId, (current) => ({
      ...current,
      lastPollError: "Automatic polling paused; a later status request or service restart will resume it.",
      updatedAt: new Date().toISOString(),
    })).catch(() => undefined);
  }

  private async refresh(job: GenerationJob, signal: AbortSignal) {
    if (this.options.mockMode) {
      const output = await this.media.storeBundledDemo({
        kind: job.kind,
        projectId: job.projectId,
        requestId: job.requestId,
      });
      return this.jobs.update(job.requestId, (current) => ({
        ...current,
        status: "completed",
        output,
        error: null,
        lastPollError: undefined,
        updatedAt: new Date().toISOString(),
      }));
    }

    const providerResult = await this.cli.use(() =>
      this.provider.getGeneration(job.providerRequestId, signal),
    );
    if (providerResult.request_id !== job.providerRequestId) {
      throw new BackendError("The provider returned the wrong job.", 502, "PROVIDER_JOB_MISMATCH");
    }

    if (providerResult.status !== "completed") {
      const error = providerResult.error ?? (
        providerResult.status === "failed"
          ? "Higgsfield reported that this generation failed."
          : undefined
      );
      return this.jobs.update(job.requestId, (current) => ({
        ...current,
        status: providerResult.status,
        ...(error ? { error } : {}),
        lastPollError: undefined,
        updatedAt: new Date().toISOString(),
      }));
    }

    const providerUrl = job.kind === "image"
      ? providerResult.images?.[0]?.url
      : providerResult.video?.url;
    if (!providerUrl) {
      throw new BackendError(
        "The provider completed without returning media.",
        502,
        "PROVIDER_MEDIA_MISSING",
      );
    }
    const output = await this.media.storeProviderMedia({
      kind: job.kind,
      projectId: job.projectId,
      providerUrl,
      requestId: job.requestId,
      signal,
    });
    return this.jobs.update(job.requestId, (current) => ({
      ...current,
      status: "completed",
      output,
      error: null,
      lastPollError: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }
}
