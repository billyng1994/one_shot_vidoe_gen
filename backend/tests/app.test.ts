import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createBackendRuntime } from "../src/app.js";
import type { BackendConfig } from "../src/config.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(dataDir: string): BackendConfig {
  return {
    assetsDir: resolve(import.meta.dirname, "..", "assets"),
    dataDir,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    host: "127.0.0.1",
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

async function waitForCompleted(app: ReturnType<typeof createBackendRuntime>["app"], requestId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/api/generations/${requestId}`);
    if (response.body.status === "completed") return response;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Generation did not complete.");
}

describe("Express backend API", () => {
  it("persists mock jobs, returns only local media, and serves byte ranges", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "backend-app-test-"));
    temporaryDirectories.push(dataDir);
    const runtime = createBackendRuntime(config(dataDir));
    await runtime.initialize();

    const image = await request(runtime.app)
      .post("/api/generations/image")
      .send({ projectId: PROJECT_ID, prompt: "A documentary portrait" })
      .expect(202);
    expect(image.body.request_id).toMatch(/^gen-image-/);
    const completedImage = await waitForCompleted(runtime.app, image.body.request_id);
    expect(completedImage.body.images[0].url).toMatch(/^\/media\//);
    expect(JSON.stringify(completedImage.body)).not.toContain("cli-image-");

    const video = await request(runtime.app)
      .post("/api/generations/video")
      .send({
        projectId: PROJECT_ID,
        prompt: "A gentle push in",
        imageRequestId: image.body.request_id,
        duration: 5,
        resolution: "720",
        cameraFixed: false,
      })
      .expect(202);
    const completedVideo = await waitForCompleted(runtime.app, video.body.request_id);
    const mediaUrl = completedVideo.body.video.url as string;

    const range = await request(runtime.app).get(mediaUrl).set("Range", "bytes=0-15").expect(206);
    expect(range.headers["accept-ranges"]).toBe("bytes");
    expect(range.headers["content-range"]).toMatch(/^bytes 0-15\//);
    expect(Number(range.headers["content-length"])).toBe(16);

    await request(runtime.app)
      .get("/media/samples/demo-video.mp4")
      .set("Range", "bytes=-12")
      .expect(206)
      .expect("Content-Length", "12");
  });

  it("rejects unowned paths and arbitrary render URLs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "backend-app-test-"));
    temporaryDirectories.push(dataDir);
    const runtime = createBackendRuntime(config(dataDir));
    await runtime.initialize();

    await request(runtime.app)
      .get("/api/generations/../../secrets")
      .expect(404);
    const render = await request(runtime.app)
      .post("/api/render")
      .field("projectId", PROJECT_ID)
      .field("videoUrl", "https://example.com/video.mp4")
      .field("title", "Safe title")
      .expect(400);
    expect(render.body.error).toMatch(/backend-managed media/);
  });
});
