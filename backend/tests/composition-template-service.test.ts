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
const UPLOADED_ASSET_ID = "55555555-5555-4555-8555-555555555555";
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
  maxAssetBytes?: number;
  maxAssetFiles?: number;
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
    ...(options.maxAssetBytes === undefined ? {} : { maxAssetBytes: options.maxAssetBytes }),
    ...(options.maxAssetFiles === undefined ? {} : { maxAssetFiles: options.maxAssetFiles }),
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
  it("caps template upload bytes and file count including unreferenced assets", async () => {
    const image = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "#d94a35" },
    }).png().toBuffer();
    const bytesHarness = await createHarness({ maxAssetBytes: 1 });
    await bytesHarness.service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Byte-limited frame",
      layers: defaultCompositionLayers(),
    });
    await expect(bytesHarness.service.uploadAsset(OWNER_A, TEMPLATE_ID, image))
      .rejects.toMatchObject({ status: 413, code: "TEMPLATE_ASSETS_TOO_LARGE" });

    const filesHarness = await createHarness({
      assetIds: [ASSET_ID, UPLOADED_ASSET_ID],
      maxAssetFiles: 1,
    });
    await filesHarness.service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "File-limited frame",
      layers: defaultCompositionLayers(),
    });
    await expect(filesHarness.service.uploadAsset(OWNER_A, TEMPLATE_ID, image)).resolves.toBeDefined();
    await expect(filesHarness.service.uploadAsset(OWNER_A, TEMPLATE_ID, image))
      .rejects.toMatchObject({ status: 409, code: "TEMPLATE_ASSET_LIMIT_REACHED" });
  });

  it("normalizes and resolves an owner-authenticated template image upload", async () => {
    const { media, service } = await createHarness({
      assetIds: [ASSET_ID, UPLOADED_ASSET_ID],
    });
    const existing = await uploadedImage(media);
    await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Editable frame",
      layers: templateLayers(existing.url),
    });
    const jpeg = await sharp({
      create: { width: 96, height: 64, channels: 3, background: "#d94a35" },
    }).jpeg().toBuffer();

    const uploaded = await service.uploadAsset(OWNER_A, TEMPLATE_ID, jpeg);

    expect(uploaded).toEqual({
      assetId: UPLOADED_ASSET_ID,
      url: `/api/composition-templates/${TEMPLATE_ID}/assets/${UPLOADED_ASSET_ID}`,
      width: 96,
      height: 64,
    });
    const resolved = await service.resolveAsset(OWNER_A, TEMPLATE_ID, UPLOADED_ASSET_ID);
    await expect(sharp(resolved.path).metadata()).resolves.toMatchObject({
      format: "png",
      width: 96,
      height: 64,
    });
    await expect(service.resolveAsset(OWNER_B, TEMPLATE_ID, UPLOADED_ASSET_ID))
      .rejects.toMatchObject({ status: 404, code: "TEMPLATE_NOT_FOUND" });
    await expect(service.deleteAsset(OWNER_A, TEMPLATE_ID, ASSET_ID))
      .rejects.toMatchObject({ status: 409, code: "TEMPLATE_ASSET_IN_USE" });
    await expect(service.deleteAsset(OWNER_A, TEMPLATE_ID, UPLOADED_ASSET_ID))
      .resolves.toBe(true);
    await expect(service.resolveAsset(OWNER_A, TEMPLATE_ID, UPLOADED_ASSET_ID))
      .rejects.toMatchObject({ status: 404, code: "TEMPLATE_ASSET_NOT_FOUND" });
  });

  it("optimistically updates editable layers and prunes assets no longer referenced", async () => {
    const { media, service } = await createHarness({
      assetIds: [ASSET_ID, UPLOADED_ASSET_ID],
    });
    const existing = await uploadedImage(media);
    const captured = await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Editable frame",
      layers: templateLayers(existing.url),
    });
    const uploaded = await service.uploadAsset(
      OWNER_A,
      TEMPLATE_ID,
      await sharp({
        create: { width: 120, height: 80, channels: 3, background: "#d94a35" },
      }).png().toBuffer(),
    );
    const current = await service.detail(OWNER_A, TEMPLATE_ID);
    const logo = current.layers.find(
      (layer): layer is ImageLayer => layer.type === "image" && layer.role === "logo",
    )!;
    const title = current.layers.find((layer) => layer.type === "text")!;

    const updated = await service.update(OWNER_A, TEMPLATE_ID, {
      name: "Updated frame",
      expectedUpdatedAt: captured.updatedAt,
      layers: [
        {
          id: "background-1",
          type: "image",
          role: "background",
          name: "Background",
          src: uploaded.url,
          x: 0,
          y: 0,
          width: 1.875,
          aspectRatio: 1.5,
          mask: "none",
        },
        logo,
        { ...title, text: "Updated template copy" },
      ],
    });

    expect(updated).toMatchObject({
      id: TEMPLATE_ID,
      name: "Updated frame",
      layerCount: 3,
      textLayerCount: 1,
      imageLayerCount: 2,
      layers: [
        { id: "background-1", role: "background", src: uploaded.url },
        { id: "brand-logo", role: "logo", src: "/gostudy-logo.svg" },
        { id: "campaign-title", text: "Updated template copy" },
      ],
    });
    await expect(service.resolveAsset(OWNER_A, TEMPLATE_ID, ASSET_ID))
      .rejects.toMatchObject({ status: 404, code: "TEMPLATE_ASSET_NOT_FOUND" });
    await expect(service.update(OWNER_A, TEMPLATE_ID, {
      name: "Stale update",
      expectedUpdatedAt: captured.updatedAt,
      layers: updated.layers,
    })).rejects.toMatchObject({ status: 409, code: "TEMPLATE_CONFLICT" });
  });

  it("prunes an unreferenced upload when a normalized update is otherwise unchanged", async () => {
    const { service } = await createHarness({ assetIds: [UPLOADED_ASSET_ID] });
    const captured = await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Editable frame",
      layers: defaultCompositionLayers(),
    });
    const uploaded = await service.uploadAsset(
      OWNER_A,
      TEMPLATE_ID,
      await sharp({
        create: { width: 24, height: 16, channels: 3, background: "#d94a35" },
      }).png().toBuffer(),
    );
    const current = await service.detail(OWNER_A, TEMPLATE_ID);

    const unchanged = await service.update(OWNER_A, TEMPLATE_ID, {
      name: "  Editable   frame  ",
      expectedUpdatedAt: captured.updatedAt,
      layers: current.layers,
    });

    expect(unchanged.updatedAt).toBe(captured.updatedAt);
    await expect(service.resolveAsset(OWNER_A, TEMPLATE_ID, uploaded.assetId))
      .rejects.toMatchObject({ status: 404, code: "TEMPLATE_ASSET_NOT_FOUND" });
  });

  it("returns an editable detail with owner-safe template asset URLs", async () => {
    const { dataDirectory, media, service } = await createHarness();
    const uploaded = await uploadedImage(media);
    await service.capture({
      ownerId: OWNER_A,
      sourceProjectId: SOURCE_PROJECT_ID,
      name: "Editable frame",
      layers: templateLayers(uploaded.url),
    });

    const detail = await service.detail(OWNER_A, TEMPLATE_ID);

    expect(detail).toMatchObject({
      version: 1,
      id: TEMPLATE_ID,
      name: "Editable frame",
      layerCount: 4,
      textLayerCount: 1,
      imageLayerCount: 3,
      layers: [
        { id: "brand-logo", src: "/gostudy-logo.svg" },
        {
          id: "portrait-back",
          src: `/api/composition-templates/${TEMPLATE_ID}/assets/${ASSET_ID}`,
        },
        { id: "campaign-title", type: "text" },
        {
          id: "portrait-badge",
          src: `/api/composition-templates/${TEMPLATE_ID}/assets/${ASSET_ID}`,
        },
      ],
    });
    expect(JSON.stringify(detail)).not.toContain(dataDirectory);
    await expect(service.detail(OWNER_B, TEMPLATE_ID)).rejects.toMatchObject({
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
  });

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
