import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createBackendRuntime } from "../src/app.js";
import type { BackendConfig } from "../src/config.js";

const PASSWORD = "correct horse battery staple";
const SETUP_TOKEN = "test-only-bootstrap-token-at-least-32-bytes";
const temporaryDirectories: string[] = [];
type TestAgent = ReturnType<typeof request.agent>;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function config(dataDir: string): BackendConfig {
  return {
    assetsDir: resolve(import.meta.dirname, "..", "assets"),
    authCookieSecure: false,
    authSessionTtlMs: 60 * 60_000,
    bootstrapToken: SETUP_TOKEN,
    dataDir,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    host: "127.0.0.1",
    loginAttemptLimit: 5,
    loginWindowMs: 60_000,
    maxCliConcurrency: 1,
    maxImageBytes: 5 * 1024 * 1024,
    maxMusicBytes: 1024 * 1024,
    maxRenderConcurrency: 1,
    maxVideoBytes: 5 * 1024 * 1024,
    mockMode: true,
    pollInitialDelayMs: 1,
    pollMaxDelayMs: 2,
    pollWindowMs: 1_000,
    port: 4000,
  };
}

function browserMutation<T extends request.Test>(test: T, csrfToken?: string): T {
  test.set("X-OneTake-Request", "1");
  if (csrfToken) test.set("X-CSRF-Token", csrfToken);
  return test;
}

function sessionCookie(response: request.Response) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("The response did not issue a session cookie.");
  return value.split(";", 1)[0]!;
}

async function bootstrap(agent: TestAgent) {
  const response = await browserMutation(agent.post("/api/auth/bootstrap"))
    .send({
      email: "admin@example.com",
      displayName: "Initial Admin",
      password: PASSWORD,
      setupToken: SETUP_TOKEN,
    })
    .expect(201);
  return {
    cookie: sessionCookie(response),
    csrfToken: response.body.csrfToken as string,
    user: response.body.user as {
      id: string;
      email: string;
      displayName: string;
      role: "admin" | "member";
      disabled: boolean;
    },
  };
}

async function createProject(agent: TestAgent, csrfToken: string, name = "Test project") {
  return browserMutation(agent.post("/api/projects"), csrfToken)
    .send({ name })
    .expect(201);
}

async function waitForCompleted(agent: TestAgent, requestId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await agent.get(`/api/generations/${requestId}`);
    if (response.body.status === "completed") return response;
    if (response.status >= 400) {
      throw new Error(`Generation polling failed with ${response.status}: ${JSON.stringify(response.body)}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Generation did not complete.");
}

describe("Express backend API", () => {
  it("authenticates accounts and persists owner-scoped projects without browser storage", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "backend-app-test-"));
    temporaryDirectories.push(dataDir);
    const runtime = createBackendRuntime(config(dataDir));
    await runtime.initialize();
    const adminAgent = request.agent(runtime.app);

    await request(runtime.app)
      .get("/api/health?check=liveness")
      .expect(200, { ok: true });
    await request(runtime.app)
      .get("/api/health")
      .expect(401, { error: "Authentication is required.", code: "AUTH_REQUIRED" });
    await request(runtime.app)
      .get("/api/admin/provider")
      .expect(401, { error: "Authentication is required.", code: "AUTH_REQUIRED" });
    await request(runtime.app)
      .get("/api/auth/session")
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({
        authenticated: false,
        setupRequired: true,
        setupTokenRequired: true,
      }));
    await request(runtime.app)
      .post("/api/auth/bootstrap")
      .send({ email: "ignored@example.com", displayName: "Ignored", password: PASSWORD })
      .expect(403, { error: "The request could not be verified.", code: "REQUEST_NOT_VERIFIED" });
    await browserMutation(request(runtime.app).post("/api/auth/bootstrap"))
      .send({
        email: "ignored@example.com",
        displayName: "Ignored",
        password: PASSWORD,
        setupToken: "incorrect-bootstrap-token-but-long-enough",
      })
      .expect(403, { error: "The setup token is incorrect.", code: "INVALID_BOOTSTRAP_TOKEN" });

    const bootstrapSession = await bootstrap(adminAgent);
    expect(bootstrapSession.user).toMatchObject({
      email: "admin@example.com",
      displayName: "Initial Admin",
      role: "admin",
      disabled: false,
    });
    expect(bootstrapSession.cookie).toMatch(/^onetake_session=[A-Za-z0-9_-]{43}$/);

    const authenticatedSession = await adminAgent.get("/api/auth/session").expect(200);
    expect(authenticatedSession.body).toMatchObject({
      authenticated: true,
      user: { id: bootstrapSession.user.id, role: "admin" },
      csrfToken: bootstrapSession.csrfToken,
    });
    expect(authenticatedSession.headers["cache-control"]).toContain("no-store");

    const providerStatus = await adminAgent.get("/api/admin/provider").expect(200);
    expect(providerStatus.body).toEqual({
      provider: "Higgsfield CLI",
      configured: true,
      mockMode: true,
      cli: { installed: true, authenticated: true, version: "demo" },
      storage: { writable: true },
      models: { image: "GPT Image 2", video: "Seedance 2.0" },
      connection: {
        kind: "ssh-loopback",
        callbackPort: 8_765,
        tunnelCommand:
          "ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 8765:127.0.0.1:8765 <vm-user>@<vm-host>",
        command:
          "docker run --rm -it --network host --mount source=one-shot-video-studio_higgsfield-auth,target=/home/backend/.higgsfield --entrypoint /usr/local/bin/higgsfield one-shot-video-backend:local auth login --port 8765",
        description:
          "Open one SSH tunnel without sudo and leave it running, then run the server command and complete login in your local browser. If SSH reports Address already in use, resume or stop the existing tunnel instead of starting another.",
      },
    });
    expect(providerStatus.headers["cache-control"]).toBe("private, no-store");
    const serializedProviderStatus = JSON.stringify(providerStatus.body);
    expect(serializedProviderStatus).not.toContain(PASSWORD);
    expect(serializedProviderStatus).not.toContain(SETUP_TOKEN);
    expect(serializedProviderStatus).not.toMatch(/(?:access|refresh)[_-]?token|credentials\.json/iu);

    await browserMutation(adminAgent.post("/api/projects"))
      .send({ name: "Missing CSRF" })
      .expect(403, { error: "The request could not be verified.", code: "CSRF_INVALID" });
    await adminAgent
      .post("/api/projects")
      .set("X-CSRF-Token", bootstrapSession.csrfToken)
      .send({ name: "Missing request marker" })
      .expect(403, { error: "The request could not be verified.", code: "CSRF_INVALID" });

    const created = await createProject(adminAgent, bootstrapSession.csrfToken, "Backend project");
    expect(created.body).toMatchObject({
      version: 2,
      name: "Backend project",
      snapshot: { version: 1, step: 1 },
    });
    const projectId = created.body.id as string;
    const updatedSnapshot = {
      ...created.body.snapshot,
      imagePrompt: "A durable server-side project",
    };
    const updated = await browserMutation(
      adminAgent.patch(`/api/projects/${projectId}`),
      bootstrapSession.csrfToken,
    )
      .send({ name: "Persisted project", snapshot: updatedSnapshot })
      .expect(200);
    expect(updated.body).toMatchObject({
      id: projectId,
      name: "Persisted project",
      snapshot: { imagePrompt: "A durable server-side project" },
    });
    await adminAgent
      .get("/api/projects")
      .expect(200)
      .expect(({ body }) => expect(body.projects).toHaveLength(1));

    const restarted = createBackendRuntime(config(dataDir));
    await restarted.initialize();
    await request(restarted.app)
      .get(`/api/projects/${projectId}`)
      .set("Cookie", bootstrapSession.cookie)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: projectId,
        name: "Persisted project",
        snapshot: { imagePrompt: "A durable server-side project" },
      }));

    await browserMutation(
      adminAgent.post("/api/auth/logout"),
      bootstrapSession.csrfToken,
    ).expect(204);
    await adminAgent
      .get("/api/auth/session")
      .expect(200, {
        authenticated: false,
        setupRequired: false,
        setupTokenRequired: true,
      });

    const login = await browserMutation(adminAgent.post("/api/auth/login"))
      .send({ email: " ADMIN@example.com ", password: PASSWORD })
      .expect(200);
    const adminCsrf = login.body.csrfToken as string;
    expect(login.body).toMatchObject({
      authenticated: true,
      user: { id: bootstrapSession.user.id, role: "admin" },
    });

    const member = await browserMutation(
      adminAgent.post("/api/admin/users"),
      adminCsrf,
    )
      .send({
        email: "member@example.com",
        displayName: "Project Member",
        password: PASSWORD,
        role: "member",
      })
      .expect(201);
    await adminAgent
      .get("/api/admin/users")
      .expect(200)
      .expect(({ body }) => expect(body.users).toHaveLength(2));

    const memberAgent = request.agent(runtime.app);
    const memberLogin = await browserMutation(memberAgent.post("/api/auth/login"))
      .send({ email: "member@example.com", password: PASSWORD })
      .expect(200);
    const memberCsrf = memberLogin.body.csrfToken as string;
    await memberAgent
      .get("/api/admin/users")
      .expect(403, { error: "Administrator access is required.", code: "ADMIN_REQUIRED" });
    await memberAgent
      .get("/api/admin/provider")
      .expect(403, { error: "Administrator access is required.", code: "ADMIN_REQUIRED" });
    await memberAgent
      .get(`/api/projects/${projectId}`)
      .expect(404, { error: "Project not found.", code: "PROJECT_NOT_FOUND" });
    const memberProject = await createProject(memberAgent, memberCsrf, "Member project");
    await adminAgent
      .get(`/api/projects/${memberProject.body.id as string}`)
      .expect(404, { error: "Project not found.", code: "PROJECT_NOT_FOUND" });

    await browserMutation(
      adminAgent.patch(`/api/admin/users/${bootstrapSession.user.id}`),
      adminCsrf,
    )
      .send({ disabled: true })
      .expect(409, {
        error: "The last enabled administrator cannot be disabled or demoted.",
        code: "LAST_ADMIN",
      });
    await browserMutation(
      adminAgent.post(`/api/admin/users/${member.body.id as string}/revoke-sessions`),
      adminCsrf,
    )
      .expect(200)
      .expect(({ body }) => expect(body.revoked).toBeGreaterThan(0));
    await memberAgent
      .get("/api/auth/session")
      .expect(200, {
        authenticated: false,
        setupRequired: false,
        setupTokenRequired: true,
      });
    await browserMutation(
      adminAgent.patch(`/api/admin/users/${member.body.id as string}`),
      adminCsrf,
    )
      .send({ disabled: true })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ id: member.body.id, disabled: true }));

    await adminAgent
      .get("/api/admin/audit?limit=50")
      .expect(200)
      .expect(({ body }) => expect(body.records.map((record: { action: string }) => record.action))
        .toEqual(expect.arrayContaining([
          "admin.bootstrap",
          "auth.logout",
          "auth.login_succeeded",
          "admin.user_created",
          "admin.user_disabled",
        ])));

    await browserMutation(
      adminAgent.delete(`/api/projects/${projectId}`),
      adminCsrf,
    )
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ deleted: true }));
    await adminAgent
      .get(`/api/projects/${projectId}`)
      .expect(404, { error: "Project not found.", code: "PROJECT_NOT_FOUND" });
  });

  it("keeps generated jobs and media private while serving authorized byte ranges", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "backend-app-test-"));
    temporaryDirectories.push(dataDir);
    const runtime = createBackendRuntime(config(dataDir));
    await runtime.initialize();
    const adminAgent = request.agent(runtime.app);
    const admin = await bootstrap(adminAgent);
    const project = await createProject(adminAgent, admin.csrfToken, "Generated media");
    const projectId = project.body.id as string;

    await request(runtime.app)
      .post("/api/generations/image")
      .send({ projectId, prompt: "Unauthenticated prompt" })
      .expect(401, { error: "Authentication is required.", code: "AUTH_REQUIRED" });
    const image = await browserMutation(
      adminAgent.post("/api/generations/image"),
      admin.csrfToken,
    )
      .send({ projectId, prompt: "A documentary portrait" })
      .expect(202);
    expect(image.body.request_id).toMatch(/^gen-image-/);
    const completedImage = await waitForCompleted(adminAgent, image.body.request_id);
    expect(completedImage.body.images[0].url).toMatch(/^\/media\//);
    expect(JSON.stringify(completedImage.body)).not.toContain("cli-image-");

    const video = await browserMutation(
      adminAgent.post("/api/generations/video"),
      admin.csrfToken,
    )
      .send({
        projectId,
        prompt: "A gentle push in",
        imageRequestId: image.body.request_id,
        duration: 5,
        resolution: "720",
        cameraFixed: false,
      })
      .expect(202);
    const completedVideo = await waitForCompleted(adminAgent, video.body.request_id);
    const mediaUrl = completedVideo.body.video.url as string;

    const range = await adminAgent.get(mediaUrl).set("Range", "bytes=0-15").expect(206);
    expect(range.headers["accept-ranges"]).toBe("bytes");
    expect(range.headers["content-range"]).toMatch(/^bytes 0-15\//);
    expect(Number(range.headers["content-length"])).toBe(16);
    await adminAgent
      .get("/media/samples/demo-video.mp4")
      .set("Range", "bytes=-12")
      .expect(206)
      .expect("Content-Length", "12");
    await request(runtime.app)
      .get(mediaUrl)
      .expect(401, { error: "Authentication is required.", code: "AUTH_REQUIRED" });

    const member = await browserMutation(
      adminAgent.post("/api/admin/users"),
      admin.csrfToken,
    )
      .send({
        email: "media-member@example.com",
        displayName: "Media Member",
        password: PASSWORD,
      })
      .expect(201);
    expect(member.body.role).toBe("member");
    const memberAgent = request.agent(runtime.app);
    await browserMutation(memberAgent.post("/api/auth/login"))
      .send({ email: "media-member@example.com", password: PASSWORD })
      .expect(200);
    await memberAgent
      .get(`/api/generations/${image.body.request_id as string}`)
      .expect(404, { error: "Project not found.", code: "PROJECT_NOT_FOUND" });
    await memberAgent
      .get(mediaUrl)
      .expect(404, { error: "Project not found.", code: "PROJECT_NOT_FOUND" });

    await adminAgent
      .get("/api/generations/../../secrets")
      .expect(404);
    const render = await browserMutation(
      adminAgent.post("/api/render"),
      admin.csrfToken,
    )
      .field("projectId", projectId)
      .field("videoUrl", "https://example.com/video.mp4")
      .field("title", "Safe title")
      .expect(400);
    expect(render.body.error).toMatch(/backend-managed media/);
  });
});
