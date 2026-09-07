import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import type { BackendConfig } from "./config.js";
import { BackendError, publicBackendError } from "./errors.js";
import { GenerationService, type ProviderAdapter } from "./generation-service.js";
import { HiggsfieldError, publicError as publicHiggsfieldError } from "./higgsfield.js";
import { JobStore } from "./job-store.js";
import { createMediaHandler } from "./media-handler.js";
import { MediaStorage } from "./media-storage.js";
import { RenderService } from "./render-service.js";
import { assertProjectId, parseBackendRequestId, validatePrompt } from "./validation.js";

type AppDependencies = {
  config: BackendConfig;
  generations: GenerationService;
  jobs: JobStore;
  media: MediaStorage;
  renders: RenderService;
};

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function requestBody(request: Request) {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new BackendError("A JSON object is required.", 400, "INVALID_JSON_BODY");
  }
  return request.body as Record<string, unknown>;
}

function createCorsMiddleware(origin: string | undefined) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (origin && (origin === "*" || request.headers.origin === origin)) {
      response.set({
        "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Origin": origin === "*" ? "*" : origin,
        Vary: "Origin",
      });
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  };
}

export function createApp(dependencies: AppDependencies): Express {
  const { config, generations, media, renders } = dependencies;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((_request, response, next) => {
    response.set({
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  app.use(createCorsMiddleware(config.corsOrigin));
  app.use("/media", createMediaHandler(media));
  app.use(express.json({ limit: "64kb", strict: true }));

  app.get(
    "/api/health",
    asyncRoute(async (request, response) => {
      if (request.query.check === "liveness") {
        response.json({ ok: true });
        return;
      }
      response.json(await generations.health());
    }),
  );

  app.post(
    "/api/generations/image",
    asyncRoute(async (request, response) => {
      const body = requestBody(request);
      assertProjectId(body.projectId);
      const prompt = validatePrompt(body.prompt, "Image prompt");
      const result = await generations.createImage(body.projectId, prompt);
      response.status(result.status === "queued" || result.status === "in_progress" ? 202 : 200).json(result);
    }),
  );

  app.post(
    "/api/generations/video",
    asyncRoute(async (request, response) => {
      const body = requestBody(request);
      assertProjectId(body.projectId);
      const prompt = validatePrompt(body.prompt, "Motion prompt");
      const imageRequest = parseBackendRequestId(body.imageRequestId);
      if (imageRequest.kind !== "image") {
        throw new BackendError(
          "A completed first-frame image job is required.",
          400,
          "INVALID_SOURCE_JOB",
        );
      }
      const duration = Number(body.duration ?? 5);
      if (!Number.isInteger(duration) || duration < 2 || duration > 12) {
        throw new BackendError(
          "Video duration must be between 2 and 12 seconds.",
          400,
          "INVALID_DURATION",
        );
      }
      if (body.resolution !== "720" && body.resolution !== "1080") {
        throw new BackendError(
          "Video resolution must be 720 or 1080.",
          400,
          "INVALID_RESOLUTION",
        );
      }
      const result = await generations.createVideo({
        cameraFixed: body.cameraFixed === true,
        duration,
        imageRequestId: imageRequest.requestId,
        projectId: body.projectId,
        prompt,
        resolution: body.resolution,
      });
      response.status(result.status === "queued" || result.status === "in_progress" ? 202 : 200).json(result);
    }),
  );

  app.get(
    "/api/generations/:requestId",
    asyncRoute(async (request, response) => {
      const requestId = parseBackendRequestId(request.params.requestId).requestId;
      response.set("Cache-Control", "no-store").json(await generations.get(requestId));
    }),
  );

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fieldNameSize: 80,
      fieldSize: 8 * 1024,
      fields: 12,
      fileSize: config.maxMusicBytes,
      files: 1,
      parts: 13,
    },
  });
  app.post(
    "/api/render",
    upload.single("music"),
    asyncRoute(async (request, response) => {
      const fields = request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
      response.status(201).json(await renders.render({ fields, music: request.file }));
    }),
  );

  app.delete(
    "/api/projects/:projectId/media",
    asyncRoute(async (request, response) => {
      const { projectId } = request.params;
      assertProjectId(projectId);
      const deletedJobs = await generations.deleteProject(projectId);
      response.json({ deleted: true, jobs: deletedJobs });
    }),
  );

  app.use((_request, response) => {
    response.status(404).json({ error: "Route not found.", code: "NOT_FOUND" });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
      _next(error);
      return;
    }
    if (error instanceof multer.MulterError) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      response.status(status).json({
        error: error.code === "LIMIT_FILE_SIZE"
          ? "Background music is too large."
          : "The multipart upload is invalid.",
        code: error.code,
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "The JSON body is invalid.", code: "INVALID_JSON_BODY" });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 413
    ) {
      response.status(413).json({ error: "The request body is too large.", code: "BODY_TOO_LARGE" });
      return;
    }
    if (error instanceof HiggsfieldError) {
      const result = publicHiggsfieldError(error);
      response.status(result.status).json(result.body);
      return;
    }
    const result = publicBackendError(error);
    response.status(result.status).json(result.body);
  });

  return app;
}

export type BackendRuntime = {
  app: Express;
  generations: GenerationService;
  jobs: JobStore;
  media: MediaStorage;
  renders: RenderService;
  initialize(): Promise<void>;
};

export function createBackendRuntime(
  config: BackendConfig,
  options: { provider?: ProviderAdapter } = {},
): BackendRuntime {
  const jobs = new JobStore(config.dataDir);
  const media = new MediaStorage(
    config.dataDir,
    config.assetsDir,
    { image: config.maxImageBytes, video: config.maxVideoBytes },
  );
  const generations = new GenerationService(
    jobs,
    media,
    {
      cliConcurrency: config.maxCliConcurrency,
      mockMode: config.mockMode,
      pollInitialDelayMs: config.pollInitialDelayMs,
      pollMaxDelayMs: config.pollMaxDelayMs,
      pollWindowMs: config.pollWindowMs,
    },
    options.provider,
  );
  const renders = new RenderService(media, config.assetsDir, {
    concurrency: config.maxRenderConcurrency,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    maxMusicBytes: config.maxMusicBytes,
    maxVideoBytes: config.maxVideoBytes,
  });
  return {
    app: createApp({ config, generations, jobs, media, renders }),
    generations,
    jobs,
    media,
    renders,
    async initialize() {
      await generations.initialize();
    },
  };
}
