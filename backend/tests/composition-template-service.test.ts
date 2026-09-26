import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  CompositionTemplateService,
} from "../src/composition-template-service.js";
import {
  defaultCompositionLayers,
  type CompositionLayer,
  type ImageLayer,
} from "../src/composition.js";
import { MediaStorage } from "../src/media-storage.js";

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const CREATED_AT = "2026-09-26T01:00:00.000Z";
const RENAMED_AT = "2026-09-26T02:00:00.000Z";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createHarness(options: {
  assetIds?: string[];
  now?: string;
  templateId?: string;
} = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "composition-template-test-"));
  temporaryDirectories.push(dataDirectory);
  const media = new MediaStorage(
    dataDirectory,
    resolve(import.meta.dirname, "..", "assets"),
    { image: 5 * 1024 * 1024, video: 5 * 1024 * 1024 },
  );
  await media.initialize();
  const assetIds = [...(options.assetIds ?? [ASSET_ID])];
  const service = new CompositionTemplateService(dataDirectory, media, {
    createId: () => options.templateId ?? TEMPLATE_ID,
    createAssetId: () => assetIds.shift() ?? ASSET_ID,
    now: () => options.now ?? CREATED_AT,
  });
  await service.initialize();
  return { dataDirectory, media, service };
}

async function uploadedImage(media: MediaStorage, projectId = SOURCE_PROJECT_ID) {
  return media.storeUploadedImage({
    projectId,
    bytes: await sharp({
      create: { width: 120, height: 80, channels: 4, background: "#396dc8" },
    }).png().toBuffer(),
  });
}

function templateLayers(src: string): CompositionLayer[] {
  const [logo, defaultText] = defaultCompositionLayers();
  const imageLayer = (id: string, x: number, y: number): ImageLayer => ({
    id,
    type: "image",
    role: "overlay",
    name: id === "portrait-back" ? "Portrait background" : "Portrait badge",
    src,
    x,
    y,
    width: 0.24,
    aspectRatio: 1.5,
    mask: id === "portrait-badge" ? "circle" : "none",
  });

  return [
    logo!,
    imageLayer("portrait-back", 0.08, 0.3),
    {
      ...defaultText!,
      id: "campaign-title",
      name: "Campaign title",
      text: "Study abroad with confidence",
      x: 0.36,
      y: 0.22,
      width: 0.56,
      fontSize: 72,
      textAlign: "right",
    },
    imageLayer("portrait-badge", 0.68, 0.62),
  ];
}

describe("CompositionTemplateService", () => {
  it("captures, lists, restarts, and renames an owner-scoped template with deduplicated private assets", async () => {
    const { dataDirectory, media, service } = await createHarness();
    const uploaded = await uploadedImage(media);

    const captured = await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "  Launch   frame  ",
      layers: templateLayers(uploaded.url),
    });

    expect(captured).toEqual({
      version: 1,
      id: TEMPLATE_ID,
      name: "Launch frame",
      framePreset: "onetake-v1",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      layerCount: 4,
      textLayerCount: 1,
      imageLayerCount: 3,
    });
    expect(await service.list(OWNER_A)).toEqual([captured]);
    expect(await service.list(OWNER_B)).toEqual([]);

    const templateDirectory = join(
      dataDirectory,
      "composition-templates",
      OWNER_A,
      TEMPLATE_ID,
    );
    expect(await readdir(join(templateDirectory, "assets"))).toEqual([`${ASSET_ID}.png`]);
    const serialized = await readFile(join(templateDirectory, "template.json"), "utf8");
    expect(serialized).not.toContain(uploaded.url);
    expect(serialized).not.toContain(SOURCE_PROJECT_ID);
    expect(serialized.match(new RegExp(ASSET_ID, "g"))).toHaveLength(2);

    const restarted = new CompositionTemplateService(dataDirectory, media, {
      now: () => RENAMED_AT,
    });
    await restarted.initialize();
    expect(await restarted.list(OWNER_A)).toEqual([captured]);
    expect((await restarted.get(OWNER_A, TEMPLATE_ID)).layers.map(({ id }) => id)).toEqual([
      "brand-logo",
      "portrait-back",
      "campaign-title",
      "portrait-badge",
    ]);

    const renamed = await restarted.rename(
      OWNER_A,
      TEMPLATE_ID,
      "  Updated   launch  ",
      captured.updatedAt,
    );
    expect(renamed).toMatchObject({
      id: TEMPLATE_ID,
      name: "Updated launch",
      createdAt: CREATED_AT,
      updatedAt: RENAMED_AT,
    });
    expect(await restarted.list(OWNER_A)).toEqual([renamed]);
  });

  it("materializes private assets into another project and keeps both sides independent", async () => {
    const { dataDirectory, media, service } = await createHarness();
    const uploaded = await uploadedImage(media);
    await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Portable frame",
      layers: templateLayers(uploaded.url),
    });

    await media.deleteProject(SOURCE_PROJECT_ID);
    await expect(
      media.resolveFile(uploaded.url.slice("/media/".length)),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });

    const materialized = await service.materialize(OWNER_A, TEMPLATE_ID, TARGET_PROJECT_ID);
    expect(materialized.template).toMatchObject({ id: TEMPLATE_ID, name: "Portable frame" });
    expect(materialized.layers.map(({ id }) => id)).toEqual([
      "brand-logo",
      "portrait-back",
      "campaign-title",
      "portrait-badge",
    ]);
    expect(materialized.layers[2]).toMatchObject({
      type: "text",
      text: "Study abroad with confidence",
      x: 0.36,
      y: 0.22,
      textAlign: "right",
    });

    const copiedImages = materialized.layers.filter(
      (layer): layer is ImageLayer => layer.type === "image" && layer.role === "overlay",
    );
    expect(copiedImages).toHaveLength(2);
    expect(copiedImages[0]!.src).toBe(copiedImages[1]!.src);
    expect(copiedImages[0]!.src).toMatch(
      new RegExp(`^/media/${TARGET_PROJECT_ID}/images/overlay-[0-9a-f-]+\\.png$`),
    );
    expect(copiedImages[0]!.src).not.toContain(SOURCE_PROJECT_ID);
    expect(materialized.copiedRelativePaths).toHaveLength(1);

    const appliedPath = materialized.copiedRelativePaths[0]!;
    const appliedFile = await media.resolveFile(appliedPath);
    await expect(sharp(appliedFile.path).metadata()).resolves.toMatchObject({
      format: "png",
      width: 120,
      height: 80,
    });

    await service.delete(OWNER_A, TEMPLATE_ID);
    await expect(service.get(OWNER_A, TEMPLATE_ID)).rejects.toMatchObject({
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
    await expect(media.resolveFile(appliedPath)).resolves.toMatchObject({
      parsed: { projectId: TARGET_PROJECT_ID, category: "images" },
    });
    await expect(stat(join(
      dataDirectory,
      "composition-templates",
      OWNER_A,
      TEMPLATE_ID,
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards target-project copies when an application is not committed", async () => {
    const { media, service } = await createHarness();
    const uploaded = await uploadedImage(media);
    await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Disposable application",
      layers: templateLayers(uploaded.url),
    });
    const materialized = await service.materialize(OWNER_A, TEMPLATE_ID, TARGET_PROJECT_ID);
    const copiedPath = materialized.copiedRelativePaths[0]!;
    await expect(media.resolveFile(copiedPath)).resolves.toBeDefined();

    await service.discardMaterialized(materialized);

    await expect(media.resolveFile(copiedPath)).rejects.toMatchObject({
      status: 404,
      code: "MEDIA_NOT_FOUND",
    });
    await expect(service.get(OWNER_A, TEMPLATE_ID)).resolves.toMatchObject({ id: TEMPLATE_ID });
  });

  it("rejects malformed captures and hides templates from other owners", async () => {
    const { media, service } = await createHarness();
    const uploaded = await uploadedImage(media);

    await expect(service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "   ",
      layers: templateLayers(uploaded.url),
    })).rejects.toMatchObject({ status: 400, code: "INVALID_TEMPLATE_NAME" });

    await expect(service.capture({
      ownerId: OWNER_A,
      sourceProjectId: TARGET_PROJECT_ID,
      name: "Foreign media",
      layers: templateLayers(uploaded.url),
    })).rejects.toMatchObject({ status: 400, code: "INVALID_COMPOSITION_TEMPLATE" });

    const captured = await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Private frame",
      layers: templateLayers(uploaded.url),
    });
    expect(captured.id).toBe(TEMPLATE_ID);

    for (const operation of [
      () => service.get(OWNER_B, TEMPLATE_ID),
      () => service.rename(OWNER_B, TEMPLATE_ID, "Stolen"),
      () => service.materialize(OWNER_B, TEMPLATE_ID, TARGET_PROJECT_ID),
      () => service.delete(OWNER_B, TEMPLATE_ID),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        status: 404,
        code: "TEMPLATE_NOT_FOUND",
      });
    }

    await expect(service.rename(OWNER_A, TEMPLATE_ID, "Stale rename", RENAMED_AT))
      .rejects.toMatchObject({ status: 409, code: "TEMPLATE_CONFLICT" });
  });

  it("reports corrupt template records without exposing partially trusted data", async () => {
    const { dataDirectory, media, service } = await createHarness();
    const uploaded = await uploadedImage(media);
    await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Soon corrupt",
      layers: templateLayers(uploaded.url),
    });
    await writeFile(
      join(dataDirectory, "composition-templates", OWNER_A, TEMPLATE_ID, "template.json"),
      "{not-json",
      "utf8",
    );

    await expect(service.get(OWNER_A, TEMPLATE_ID)).rejects.toMatchObject({
      status: 500,
      code: "CORRUPT_COMPOSITION_TEMPLATE",
    });
    await expect(service.delete(OWNER_A, TEMPLATE_ID)).resolves.toBe(true);
    await expect(service.get(OWNER_A, TEMPLATE_ID)).rejects.toMatchObject({
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
  });

  it("reports a missing private image as corruption instead of a missing template", async () => {
    const { dataDirectory, media, service } = await createHarness();
    const uploaded = await uploadedImage(media);
    await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Damaged assets",
      layers: templateLayers(uploaded.url),
    });
    await rm(join(
      dataDirectory,
      "composition-templates",
      OWNER_A,
      TEMPLATE_ID,
      "assets",
      `${ASSET_ID}.png`,
    ));

    await expect(service.get(OWNER_A, TEMPLATE_ID)).rejects.toMatchObject({
      status: 500,
      code: "CORRUPT_COMPOSITION_TEMPLATE",
    });
    await expect(service.delete(OWNER_A, TEMPLATE_ID)).resolves.toBe(true);
  });
});
