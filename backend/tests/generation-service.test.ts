import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GenerationService, type ProviderAdapter } from "../src/generation-service.js";
import { JobStore } from "../src/job-store.js";
import { MediaStorage } from "../src/media-storage.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];
const assetsDirectory = resolve(import.meta.dirname, "..", "assets");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitForCompleted(service: GenerationService, requestId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await service.get(requestId);
    if (result.status === "completed") return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Mock generation did not finish.");
}

describe("generation service", () => {
  it("copies mock image and video into durable project storage", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "backend-generation-test-"));
    temporaryDirectories.push(dataDirectory);
    const jobs = new JobStore(dataDirectory);
    const media = new MediaStorage(
      dataDirectory,
      assetsDirectory,
      { image: 5 * 1024 * 1024, video: 5 * 1024 * 1024 },
    );
    const service = new GenerationService(jobs, media, {
      cliConcurrency: 1,
      mockMode: true,
      pollInitialDelayMs: 1,
      pollMaxDelayMs: 2,
      pollWindowMs: 1_000,
    });
    await service.initialize();

    const image = await service.createImage(PROJECT_ID, "A documentary portrait");
    expect(image.request_id).toMatch(/^gen-image-/);
    const completedImage = await waitForCompleted(service, image.request_id);
    expect(completedImage.images?.[0]?.url).toMatch(/^\/media\/.+\/images\/gen-image-/);

    const video = await service.createVideo({
      cameraFixed: true,
      duration: 5,
      imageRequestId: image.request_id,
      projectId: PROJECT_ID,
      prompt: "A gentle push in",
      resolution: "720",
    });
    const completedVideo = await waitForCompleted(service, video.request_id);
    expect(completedVideo.video?.url).toMatch(/^\/media\/.+\/videos\/gen-video-/);

    const videoJob = await jobs.read(video.request_id);
    expect(videoJob.providerRequestId).toMatch(/^cli-video-/);
    expect(videoJob.sourceImageRequestId).toBe(image.request_id);
    const videoFile = await media.resolveFile(videoJob.output!.relativePath);
    expect((await stat(videoFile.path)).size).toBeGreaterThan(0);
    const json = await readFile(join(dataDirectory, "jobs", `${video.request_id}.json`), "utf8");
    expect(json).not.toContain("/media/samples/");
  });

  it("resumes an unfinished persisted job without a browser poll", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "backend-generation-test-"));
    temporaryDirectories.push(dataDirectory);
    const jobs = new JobStore(dataDirectory);
    const media = new MediaStorage(
      dataDirectory,
      assetsDirectory,
      { image: 5 * 1024 * 1024, video: 5 * 1024 * 1024 },
    );
    const now = new Date().toISOString();
    const requestId = "gen-image-22222222-2222-4222-8222-222222222222";
    await jobs.create({
      version: 1,
      requestId,
      providerRequestId: "cli-image-33333333-3333-4333-8333-333333333333",
      projectId: PROJECT_ID,
      kind: "image",
      prompt: "A persisted portrait",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    const restartedService = new GenerationService(jobs, media, {
      cliConcurrency: 1,
      mockMode: true,
      pollInitialDelayMs: 1,
      pollMaxDelayMs: 2,
      pollWindowMs: 1_000,
    });

    await restartedService.initialize();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await jobs.read(requestId)).status === "completed") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const persisted = await jobs.read(requestId);
    expect(persisted.status).toBe("completed");
    expect(persisted.output?.relativePath).toContain(`${PROJECT_ID}/images/${requestId}`);
  });

  it("translates the opaque source ID back to its stored provider image ID", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "backend-generation-test-"));
    temporaryDirectories.push(dataDirectory);
    const jobs = new JobStore(dataDirectory);
    const media = new MediaStorage(
      dataDirectory,
      assetsDirectory,
      { image: 5 * 1024 * 1024, video: 5 * 1024 * 1024 },
    );
    const imageRequestId = "gen-image-22222222-2222-4222-8222-222222222222";
    const providerImageId = "cli-image-33333333-3333-4333-8333-333333333333";
    const providerVideoId = "cli-video-44444444-4444-4444-8444-444444444444";
    const output = await media.storeBundledDemo({
      kind: "image",
      projectId: PROJECT_ID,
      requestId: imageRequestId,
    });
    const now = new Date().toISOString();
    await jobs.create({
      version: 1,
      requestId: imageRequestId,
      providerRequestId: providerImageId,
      projectId: PROJECT_ID,
      kind: "image",
      prompt: "A source portrait",
      status: "completed",
      output,
      createdAt: now,
      updatedAt: now,
    });
    const findRecentVideo = vi.fn<ProviderAdapter["findRecentVideo"]>(async () => ({
      status: "queued",
      request_id: providerVideoId,
    }));
    const provider: ProviderAdapter = {
      findRecentImage: async () => undefined,
      findRecentVideo,
      getGeneration: async () => ({ status: "canceled", request_id: providerVideoId }),
      health: async () => ({ installed: true, authenticated: true, version: "test" }),
      imageModel: () => "gpt_image_2",
      submitImage: async () => ({ status: "queued", request_id: providerImageId }),
      submitVideo: async () => ({ status: "queued", request_id: providerVideoId }),
      videoModel: () => "seedance_2_0",
    };
    const service = new GenerationService(
      jobs,
      media,
      {
        cliConcurrency: 1,
        mockMode: false,
        pollInitialDelayMs: 1,
        pollMaxDelayMs: 2,
        pollWindowMs: 1_000,
      },
      provider,
    );

    const created = await service.createVideo({
      cameraFixed: false,
      duration: 5,
      imageRequestId,
      projectId: PROJECT_ID,
      prompt: "A gentle motion",
      resolution: "720",
    });

    expect(created.request_id).toMatch(/^gen-video-/);
    expect(findRecentVideo).toHaveBeenCalledWith(
      expect.objectContaining({ imageRequestId: providerImageId }),
    );
    expect((await jobs.read(created.request_id)).sourceImageRequestId).toBe(imageRequestId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await jobs.read(created.request_id)).status === "canceled") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect((await jobs.read(created.request_id)).status).toBe("canceled");
  });

  it("waits for an active worker before project cleanup so files cannot reappear", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "backend-generation-test-"));
    temporaryDirectories.push(dataDirectory);
    const jobs = new JobStore(dataDirectory);
    let releaseCopy!: () => void;
    let markCopyStarted!: () => void;
    const copyStarted = new Promise<void>((resolvePromise) => {
      markCopyStarted = resolvePromise;
    });
    const copyGate = new Promise<void>((resolvePromise) => {
      releaseCopy = resolvePromise;
    });
    class SlowMediaStorage extends MediaStorage {
      override async storeBundledDemo(input: Parameters<MediaStorage["storeBundledDemo"]>[0]) {
        markCopyStarted();
        await copyGate;
        return super.storeBundledDemo(input);
      }
    }
    const media = new SlowMediaStorage(
      dataDirectory,
      assetsDirectory,
      { image: 5 * 1024 * 1024, video: 5 * 1024 * 1024 },
    );
    const service = new GenerationService(jobs, media, {
      cliConcurrency: 1,
      mockMode: true,
      pollInitialDelayMs: 1,
      pollMaxDelayMs: 2,
      pollWindowMs: 1_000,
    });
    await service.initialize();
    await service.createImage(PROJECT_ID, "A deletion race portrait");
    await copyStarted;

    let deletionFinished = false;
    const deletion = service.deleteProject(PROJECT_ID).then((count) => {
      deletionFinished = true;
      return count;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(deletionFinished).toBe(false);
    releaseCopy();

    expect(await deletion).toBe(1);
    expect(await jobs.list()).toEqual([]);
    await expect(stat(join(dataDirectory, "media", PROJECT_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await media.resolvePublicFile("samples/demo-image.svg")).toMatchObject({
      parsed: { projectId: "samples" },
    });
  });
});
