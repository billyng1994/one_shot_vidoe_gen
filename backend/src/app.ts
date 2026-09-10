import { createHash, timingSafeEqual } from "node:crypto";

import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import multer from "multer";

import {
  AuthError,
  AuthService,
  AuthStore,
  auditContextFromRequest,
  clearSessionCookie,
  createAuthenticationMiddleware,
  getAuthenticatedSession,
  getSessionTokenFromRequest,
  requireAdministrator,
  requireAuthenticatedSession,
  requireAuthentication,
  setSessionCookie,
  type SessionCookieConfig,
  type SessionGrant,
} from "./auth.js";
import type { BackendConfig } from "./config.js";
import { BackendError, publicBackendError } from "./errors.js";
import { GenerationService, type ProviderAdapter } from "./generation-service.js";
import { HiggsfieldError, publicError as publicHiggsfieldError } from "./higgsfield.js";
import { JobStore } from "./job-store.js";
import { createMediaHandler } from "./media-handler.js";
import { MediaStorage } from "./media-storage.js";
import { ProjectService } from "./project-store.js";
import { ProviderManagementService } from "./provider-management.js";
import { RenderService } from "./render-service.js";
import { assertProjectId, parseBackendRequestId, validatePrompt } from "./validation.js";

type AppDependencies = {
  auth: AuthService;
  config: BackendConfig;
  generations: GenerationService;
  jobs: JobStore;
  media: MediaStorage;
  projects: ProjectService;
  providerManagement: ProviderManagementService;
  renders: RenderService;
};

type LoginAttempt = {
  attempts: number;
  resetAt: number;
};

class LoginRateLimiter {
  private readonly entries = new Map<string, LoginAttempt>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private key(value: unknown) {
    const identifier = typeof value === "string"
      ? value.normalize("NFKC").trim().toLowerCase().slice(0, 1_024)
      : String(typeof value);
    return createHash("sha256").update(identifier, "utf8").digest("hex");
  }

  assertAllowed(value: unknown) {
    const now = Date.now();
    const entry = this.entries.get(this.key(value));
    if (entry && entry.resetAt > now && entry.attempts >= this.limit) {
      throw new AuthError(
        "Too many login attempts. Try again later.",
        429,
        "LOGIN_RATE_LIMITED",
      );
    }
  }

  recordFailure(value: unknown) {
    const now = Date.now();
    const key = this.key(value);
    const current = this.entries.get(key);
    this.entries.set(key, current && current.resetAt > now
      ? { attempts: current.attempts + 1, resetAt: current.resetAt }
      : { attempts: 1, resetAt: now + this.windowMs });

    if (this.entries.size > 10_000) {
      for (const [entryKey, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(entryKey);
      }
    }
  }

  clear(value: unknown) {
    this.entries.delete(this.key(value));
  }
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

function requestBody(request: Request) {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new BackendError("A JSON object is required.", 400, "INVALID_JSON_BODY");
  }
  return request.body as Record<string, unknown>;
}

function createCorsMiddleware(origin: string | undefined): RequestHandler {
  return (request, response, next) => {
    response.vary("Origin");
    if (origin && request.headers.origin === origin) {
      response.set({
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers":
          "Content-Type, Idempotency-Key, X-CSRF-Token, X-OneTake-Request",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Origin": origin,
      });
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  };
}

function csrfToken(sessionToken: string) {
  return createHash("sha256").update(`onetake-csrf\0${sessionToken}`, "utf8").digest("base64url");
}

function safeEqual(left: string | undefined, right: string) {
  if (!left) return false;
  const candidate = Buffer.from(left, "utf8");
  const expected = Buffer.from(right, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function secretEqual(left: unknown, right: string) {
  const candidate = createHash("sha256")
    .update(typeof left === "string" ? left : "", "utf8")
    .digest();
  const expected = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(candidate, expected);
}

function requireBrowserMutation(request: Request, _response: Response, next: NextFunction) {
  if (
    request.get("x-onetake-request") !== "1" ||
    request.get("sec-fetch-site") === "cross-site"
  ) {
    next(new AuthError("The request could not be verified.", 403, "REQUEST_NOT_VERIFIED"));
    return;
  }
  next();
}

function createCsrfMiddleware(cookieConfig: SessionCookieConfig): RequestHandler {
  return (request, response, next) => {
    if (!getAuthenticatedSession(response)) {
      next(new AuthError("Authentication is required.", 401, "AUTH_REQUIRED"));
      return;
    }
    const token = getSessionTokenFromRequest(request, cookieConfig);
    const supplied = request.get("x-csrf-token");
    if (
      request.get("x-onetake-request") !== "1" ||
      request.get("sec-fetch-site") === "cross-site" ||
      !token ||
      !safeEqual(supplied, csrfToken(token))
    ) {
      next(new AuthError("The request could not be verified.", 403, "CSRF_INVALID"));
      return;
    }
    next();
  };
}

function authenticatedPayload(grant: SessionGrant, token = grant.token) {
  return {
    authenticated: true as const,
    user: grant.user,
    expiresAt: grant.expiresAt,
    csrfToken: csrfToken(token),
  };
}

function sessionPayload(
  authenticated: ReturnType<typeof requireAuthenticatedSession>,
  token: string,
) {
  return {
    authenticated: true as const,
    user: authenticated.user,
    expiresAt: authenticated.expiresAt,
    csrfToken: csrfToken(token),
  };
}

export function createApp(dependencies: AppDependencies): Express {
  const {
    auth,
    config,
    generations,
    jobs,
    media,
    projects,
    providerManagement,
    renders,
  } = dependencies;
  const app = express();
  const cookieConfig: SessionCookieConfig = {
    name: config.authCookieSecure ? "__Host-onetake_session" : "onetake_session",
    path: "/",
    sameSite: "strict",
    secure: config.authCookieSecure,
  };
  const csrf = createCsrfMiddleware(cookieConfig);
  const loginLimiter = new LoginRateLimiter(config.loginAttemptLimit, config.loginWindowMs);

  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((_request, response, next) => {
    response.set({
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    next();
  });
  app.use(createCorsMiddleware(config.corsOrigin));
  app.use(express.json({ limit: "1mb", strict: true }));

  app.get("/api/health", asyncRoute(async (request, response, next) => {
    if (request.query.check === "liveness") {
      response.json({ ok: true });
      return;
    }
    next();
  }));

  app.use(createAuthenticationMiddleware(auth, cookieConfig));

  app.get("/api/auth/session", asyncRoute(async (request, response) => {
    response.set("Cache-Control", "private, no-store");
    const authenticated = getAuthenticatedSession(response);
    const token = getSessionTokenFromRequest(request, cookieConfig);
    if (authenticated && token) {
      response.json(sessionPayload(authenticated, token));
      return;
    }
    response.json({
      authenticated: false,
      setupRequired: await auth.bootstrapRequired(),
      setupTokenRequired: true,
    });
  }));

  app.post("/api/auth/bootstrap", requireBrowserMutation, asyncRoute(async (request, response) => {
    const body = requestBody(request);
    if (!secretEqual(body.setupToken, config.bootstrapToken)) {
      throw new AuthError("The setup token is incorrect.", 403, "INVALID_BOOTSTRAP_TOKEN");
    }
    const grant = await auth.bootstrapFirstAdmin(body, auditContextFromRequest(request));
    setSessionCookie(response, grant, cookieConfig);
    response.status(201).json(authenticatedPayload(grant));
  }));

  app.post("/api/auth/login", requireBrowserMutation, asyncRoute(async (request, response) => {
    const body = requestBody(request);
    loginLimiter.assertAllowed(body.email);
    try {
      const grant = await auth.login(body, auditContextFromRequest(request));
      loginLimiter.clear(body.email);
      setSessionCookie(response, grant, cookieConfig);
      response.json(authenticatedPayload(grant));
    } catch (error) {
      if (error instanceof AuthError && error.code === "INVALID_CREDENTIALS") {
        loginLimiter.recordFailure(body.email);
      }
      throw error;
    }
  }));

  app.post(
    "/api/auth/logout",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      await auth.revokeSession(
        getSessionTokenFromRequest(request, cookieConfig),
        auditContextFromRequest(request),
      );
      clearSessionCookie(response, cookieConfig);
      response.status(204).end();
    }),
  );

  app.patch(
    "/api/account/profile",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      const user = await auth.updateOwnProfile(
        requireAuthenticatedSession(response),
        requestBody(request),
        auditContextFromRequest(request),
      );
      response.json({ user });
    }),
  );

  app.post(
    "/api/account/password",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      const grant = await auth.changeOwnPassword(
        requireAuthenticatedSession(response),
        requestBody(request),
        auditContextFromRequest(request),
      );
      setSessionCookie(response, grant, cookieConfig);
      response.json(authenticatedPayload(grant));
    }),
  );

  app.use(
    "/media",
    requireAuthentication,
    asyncRoute(async (request, response, next) => {
      const relativePath = (request.url.split("?", 1)[0] ?? "").replace(/^\/+/, "");
      const projectId = relativePath.split("/", 1)[0] ?? "";
      if (projectId !== "samples") {
        assertProjectId(projectId);
        await projects.get(requireAuthenticatedSession(response).user.id, projectId);
      }
      next();
    }),
    createMediaHandler(media),
  );

  app.get(
    "/api/health",
    requireAuthentication,
    asyncRoute(async (_request, response) => {
      response.json(await generations.health());
    }),
  );

  app.get(
    "/api/projects",
    requireAuthentication,
    asyncRoute(async (_request, response) => {
      const ownerId = requireAuthenticatedSession(response).user.id;
      response.json({ projects: await projects.list(ownerId) });
    }),
  );

  app.post(
    "/api/projects",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      const body = requestBody(request);
      const ownerId = requireAuthenticatedSession(response).user.id;
      response.status(201).json(await projects.create(ownerId, {
        ...(Object.prototype.hasOwnProperty.call(body, "name")
          ? { name: body.name as string }
          : {}),
      }));
    }),
  );

  app.get(
    "/api/projects/:projectId",
    requireAuthentication,
    asyncRoute(async (request, response) => {
      const ownerId = requireAuthenticatedSession(response).user.id;
      const { projectId } = request.params;
      assertProjectId(projectId);
      response.json(await projects.get(ownerId, projectId));
    }),
  );

  app.patch(
    "/api/projects/:projectId",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      const body = requestBody(request);
      const ownerId = requireAuthenticatedSession(response).user.id;
      const { projectId } = request.params;
      assertProjectId(projectId);
      response.json(await projects.update(ownerId, projectId, {
        ...(Object.prototype.hasOwnProperty.call(body, "name")
          ? { name: body.name as string }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "snapshot")
          ? { snapshot: body.snapshot as never }
          : {}),
      }));
    }),
  );

  app.post(
    "/api/generations/image",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      const body = requestBody(request);
      assertProjectId(body.projectId);
      await projects.get(requireAuthenticatedSession(response).user.id, body.projectId);
      const prompt = validatePrompt(body.prompt, "Image prompt");
      const result = await generations.createImage(body.projectId, prompt);
      response.status(result.status === "queued" || result.status === "in_progress" ? 202 : 200).json(result);
    }),
  );

  app.post(
    "/api/generations/video",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      const body = requestBody(request);
      assertProjectId(body.projectId);
      await projects.get(requireAuthenticatedSession(response).user.id, body.projectId);
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
    requireAuthentication,
    asyncRoute(async (request, response) => {
      const requestId = parseBackendRequestId(request.params.requestId).requestId;
      const job = await jobs.read(requestId);
      await projects.get(requireAuthenticatedSession(response).user.id, job.projectId);
      response.set("Cache-Control", "private, no-store").json(await generations.get(requestId));
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
    requireAuthentication,
    csrf,
    upload.single("music"),
    asyncRoute(async (request, response) => {
      const fields = request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
      assertProjectId(fields.projectId);
      await projects.get(requireAuthenticatedSession(response).user.id, fields.projectId);
      response.status(201).json(await renders.render({ fields, music: request.file }));
    }),
  );

  app.delete(
    "/api/projects/:projectId/media",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      const { projectId } = request.params;
      assertProjectId(projectId);
      await projects.get(requireAuthenticatedSession(response).user.id, projectId);
      const deletedJobs = await generations.deleteProject(projectId);
      response.json({ deleted: true, jobs: deletedJobs });
    }),
  );

  app.delete(
    "/api/projects/:projectId",
    requireAuthentication,
    csrf,
    asyncRoute(async (request, response) => {
      const { projectId } = request.params;
      assertProjectId(projectId);
      const ownerId = requireAuthenticatedSession(response).user.id;
      await projects.get(ownerId, projectId);
      const deletedJobs = await generations.deleteProject(projectId);
      await projects.delete(ownerId, projectId);
      response.json({ deleted: true, jobs: deletedJobs });
    }),
  );

  app.get(
    "/api/admin/provider",
    requireAdministrator,
    asyncRoute(async (_request, response) => {
      response.set("Cache-Control", "private, no-store");
      response.json(await providerManagement.status());
    }),
  );

  app.get(
    "/api/admin/users",
    requireAdministrator,
    asyncRoute(async (_request, response) => {
      response.json({ users: await auth.listUsers(requireAuthenticatedSession(response)) });
    }),
  );

  app.post(
    "/api/admin/users",
    requireAdministrator,
    csrf,
    asyncRoute(async (request, response) => {
      response.status(201).json(await auth.createUser(
        requireAuthenticatedSession(response),
        requestBody(request),
        auditContextFromRequest(request),
      ));
    }),
  );

  app.patch(
    "/api/admin/users/:userId",
    requireAdministrator,
    csrf,
    asyncRoute(async (request, response) => {
      response.json(await auth.updateUser(
        requireAuthenticatedSession(response),
        request.params.userId,
        requestBody(request),
        auditContextFromRequest(request),
      ));
    }),
  );

  app.post(
    "/api/admin/users/:userId/revoke-sessions",
    requireAdministrator,
    csrf,
    asyncRoute(async (request, response) => {
      const revoked = await auth.revokeUserSessions(
        requireAuthenticatedSession(response),
        request.params.userId,
        auditContextFromRequest(request),
      );
      response.json({ revoked });
    }),
  );

  app.get(
    "/api/admin/audit",
    requireAdministrator,
    asyncRoute(async (request, response) => {
      const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
      response.json({
        records: await auth.listAuditRecords(requireAuthenticatedSession(response), limit),
      });
    }),
  );

  app.use((_request, response) => {
    response.status(404).json({ error: "Route not found.", code: "NOT_FOUND" });
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
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
    if (error && typeof error === "object" && "status" in error && error.status === 413) {
      response.status(413).json({ error: "The request body is too large.", code: "BODY_TOO_LARGE" });
      return;
    }
    if (error instanceof HiggsfieldError) {
      const result = publicHiggsfieldError(error);
      response.status(result.status).json(result.body);
      return;
    }
    const result = publicBackendError(error);
    if (result.status === 429) response.set("Retry-After", String(Math.ceil(config.loginWindowMs / 1_000)));
    response.status(result.status).json(result.body);
  });

  return app;
}

export type BackendRuntime = {
  app: Express;
  auth: AuthService;
  generations: GenerationService;
  jobs: JobStore;
  media: MediaStorage;
  projects: ProjectService;
  providerManagement: ProviderManagementService;
  renders: RenderService;
  initialize(): Promise<void>;
};

export function createBackendRuntime(
  config: BackendConfig,
  options: { provider?: ProviderAdapter } = {},
): BackendRuntime {
  const auth = new AuthService(new AuthStore(config.dataDir), {
    sessionTtlMs: config.authSessionTtlMs,
  });
  const jobs = new JobStore(config.dataDir);
  const media = new MediaStorage(
    config.dataDir,
    config.assetsDir,
    { image: config.maxImageBytes, video: config.maxVideoBytes },
  );
  const projects = new ProjectService(config.dataDir);
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
  const providerManagement = new ProviderManagementService(generations);
  const renders = new RenderService(media, config.assetsDir, {
    concurrency: config.maxRenderConcurrency,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    maxMusicBytes: config.maxMusicBytes,
    maxVideoBytes: config.maxVideoBytes,
  });
  return {
    app: createApp({
      auth,
      config,
      generations,
      jobs,
      media,
      projects,
      providerManagement,
      renders,
    }),
    auth,
    generations,
    jobs,
    media,
    projects,
    providerManagement,
    renders,
    async initialize() {
      await Promise.all([auth.initialize(), projects.initialize(), generations.initialize()]);
    },
  };
}
