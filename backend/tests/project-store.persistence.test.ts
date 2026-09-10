import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEmptyStudioSnapshot,
  validateStudioSnapshot,
  type StudioProject,
  type StudioSnapshot,
} from "../src/project-schema.js";
import { ProjectStore } from "../src/project-store.js";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-09-10T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryStore(options: ConstructorParameters<typeof ProjectStore>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "project-store-persistence-test-"));
  temporaryDirectories.push(directory);
  return { directory, store: new ProjectStore(directory, options) };
}

function completeSnapshot(prompt = "An editorial portrait"): StudioSnapshot {
  return {
    ...createEmptyStudioSnapshot(),
    step: 3,
    imagePrompt: prompt,
    motionPrompt: "Slow push in",
    image: {
      requestId: "gen-image-33333333-3333-4333-8333-333333333333",
      url: `/media/${PROJECT_A}/images/frame.png`,
    },
    video: {
      requestId: "gen-video-44444444-4444-4444-8444-444444444444",
      url: `/media/${PROJECT_A}/videos/clip.mp4`,
    },
    duration: 8,
    resolution: "1080",
    cameraFixed: true,
    title: { text: "A saved title", x: 0.2, y: 0.3, fontSize: 72 },
    musicVolume: 0.35,
  };
}

function localProject(overrides: Partial<StudioProject> = {}): StudioProject {
  return {
    version: 2,
    id: PROJECT_A,
    name: "Imported project",
    createdAt: NOW,
    updatedAt: NOW,
    snapshot: completeSnapshot(),
    ...overrides,
  };
}

describe("per-owner project persistence", () => {
  it("atomically stores owner-scoped documents under the backend data directory", async () => {
    const { directory, store } = await temporaryStore({ createId: () => PROJECT_A, now: () => NOW });
    const created = await store.create(OWNER_A, { name: "  Campaign   A  " });

    expect(created).toMatchObject({ id: PROJECT_A, name: "Campaign A", createdAt: NOW });
    expect(await store.list(OWNER_A)).toEqual([created]);
    await expect(store.get(OWNER_B, PROJECT_A)).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });

    const ownerDirectory = join(directory, "projects", OWNER_A);
    expect(await readdir(ownerDirectory)).toEqual([`${PROJECT_A}.json`]);
    const stored = JSON.parse(await readFile(join(ownerDirectory, `${PROJECT_A}.json`), "utf8"));
    expect(stored).toEqual({ storageVersion: 1, ownerId: OWNER_A, project: created });
  });

  it("reserves each project/media namespace for exactly one owner", async () => {
    const { store } = await temporaryStore({ createId: () => PROJECT_A, now: () => NOW });
    await store.create(OWNER_A, { name: "Owner A project" });

    await expect(store.create(OWNER_B, { name: "Owner B collision" })).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_EXISTS",
    });
    await expect(store.importLocalProjects(OWNER_B, localProject())).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_ID_OWNED",
    });
  });

  it("serializes same-owner creates and partial updates without losing fields", async () => {
    const times = [NOW, "2026-09-10T12:01:00.000Z", "2026-09-10T12:02:00.000Z"];
    const { store } = await temporaryStore({
      createId: () => PROJECT_A,
      now: () => times.shift() ?? "2026-09-10T12:03:00.000Z",
    });
    const attempts = await Promise.allSettled([
      store.create(OWNER_A, { id: PROJECT_A, name: "First" }),
      store.create(OWNER_A, { id: PROJECT_A, name: "Duplicate" }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "PROJECT_EXISTS" },
    });

    await Promise.all([
      store.update(OWNER_A, PROJECT_A, { name: "Renamed" }),
      store.update(OWNER_A, PROJECT_A, { snapshot: completeSnapshot("Updated prompt") }),
    ]);
    expect(await store.get(OWNER_A, PROJECT_A)).toMatchObject({
      name: "Renamed",
      snapshot: { imagePrompt: "Updated prompt" },
    });
  });

  it("imports localStorage StudioProject objects idempotently and only accepts newer copies", async () => {
    const { store } = await temporaryStore();
    const browserProject = {
      ...localProject({ id: "legacy-v1", source: "legacy-studio-v1" }),
      name: "  Legacy   project  ",
      snapshot: {
        version: 1,
        step: 3,
        imagePrompt: "x".repeat(4_100),
        motionPrompt: 123,
        image: { requestId: "../../secret", url: "javascript:alert(1)" },
        video: {},
        duration: 12,
        resolution: "4k",
        cameraFixed: "yes",
        title: { text: "", x: -5, y: 10, fontSize: 900 },
        musicVolume: 4,
      },
    };

    const first = await store.importLocalProjects(OWNER_A, browserProject);
    const second = await store.importLocalProjects(OWNER_A, JSON.stringify(browserProject));

    expect(first).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(await store.get(OWNER_A, "legacy-v1")).toMatchObject({
      name: "Legacy project",
      snapshot: {
        step: 1,
        imagePrompt: "x".repeat(4_000),
        motionPrompt: "",
        duration: 5,
        resolution: "720",
        cameraFixed: false,
        title: { text: "Your story starts here", x: 0.02, y: 0.84, fontSize: 132 },
        musicVolume: 1,
      },
    });

    const newer = {
      ...browserProject,
      name: "Newer browser copy",
      updatedAt: "2026-09-10T12:05:00.000Z",
    };
    expect(await store.importLocalProjects(OWNER_A, newer)).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 0,
    });
    expect((await store.get(OWNER_A, "legacy-v1")).name).toBe("Newer browser copy");
  });

  it("enforces every frontend snapshot bound on normal writes", async () => {
    const valid = completeSnapshot();
    expect(validateStudioSnapshot(valid)).toEqual(valid);

    const invalidSnapshots = [
      { ...valid, step: 4 },
      { ...valid, imagePrompt: "x".repeat(4_001) },
      { ...valid, motionPrompt: "x".repeat(4_001) },
      { ...valid, image: { requestId: "unsafe", url: valid.image.url } },
      { ...valid, video: { requestId: valid.video.requestId, url: "http://example.test/v.mp4" } },
      { ...valid, duration: 6 },
      { ...valid, resolution: "4k" },
      { ...valid, cameraFixed: 1 },
      { ...valid, title: { ...valid.title, text: "x".repeat(181) } },
      { ...valid, title: { ...valid.title, x: 0.01 } },
      { ...valid, title: { ...valid.title, y: 0.85 } },
      { ...valid, title: { ...valid.title, fontSize: 133 } },
      { ...valid, musicVolume: 1.01 },
    ];
    for (const snapshot of invalidSnapshots) {
      expect(() => validateStudioSnapshot(snapshot)).toThrow();
    }

    const { store } = await temporaryStore();
    await expect(store.create("../../owner", { id: PROJECT_A })).rejects.toMatchObject({
      code: "INVALID_OWNER_ID",
    });
    await expect(store.create(OWNER_A, { id: "../../project" })).rejects.toMatchObject({
      code: "INVALID_PROJECT_ID",
    });
  });

  it("deletes metadata without deleting generated media", async () => {
    const { directory, store } = await temporaryStore({ now: () => NOW });
    await store.create(OWNER_A, { id: PROJECT_B, name: "Disposable metadata" });
    const mediaFile = join(directory, "media", PROJECT_B, "images", "frame.png");
    await mkdir(join(directory, "media", PROJECT_B, "images"), { recursive: true });
    await writeFile(mediaFile, "media remains", "utf8");

    expect(await store.delete(OWNER_A, PROJECT_B)).toBe(true);
    expect(await store.delete(OWNER_A, PROJECT_B)).toBe(false);
    await expect(store.get(OWNER_A, PROJECT_B)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await readFile(mediaFile, "utf8")).toBe("media remains");
  });
});
