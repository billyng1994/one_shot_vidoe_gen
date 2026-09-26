import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_LOGO_SRC,
  validateCompositionLayers,
  type CompositionLayer,
  type ImageLayer,
  type TextLayer,
} from "./composition.js";
import { BackendError } from "./errors.js";
import { MediaStorage } from "./media-storage.js";
import { validateOwnerId, validateProjectId } from "./project-schema.js";
import { UUID_PATTERN, parseLocalMediaUrl } from "./validation.js";

export const COMPOSITION_TEMPLATE_VERSION = 1 as const;
export const MAX_COMPOSITION_TEMPLATES_PER_OWNER = 50;
const MAX_TEMPLATE_NAME_LENGTH = 80;
const MAX_TEMPLATE_ASSET_BYTES = 128 * 1024 * 1024;
const TEMPLATE_FILENAME = "template.json";

type BuiltinTemplateSource = {
  kind: "builtin";
  key: "gostudy-logo";
};

type AssetTemplateSource = {
  kind: "asset";
  assetId: string;
};

type TemplateImageSource = BuiltinTemplateSource | AssetTemplateSource;

type StoredTemplateImageLayer = Omit<ImageLayer, "src"> & {
  source: TemplateImageSource;
};

type StoredTemplateLayer = TextLayer | StoredTemplateImageLayer;

type StoredCompositionTemplate = {
  version: 1;
  id: string;
  name: string;
  framePreset: "onetake-v1";
  createdAt: string;
  updatedAt: string;
  layers: StoredTemplateLayer[];
};

type TemplateEnvelope = {
  storageVersion: 1;
  ownerId: string;
  template: StoredCompositionTemplate;
};

export type CompositionTemplateSummary = {
  version: 1;
  id: string;
  name: string;
  framePreset: "onetake-v1";
  createdAt: string;
  updatedAt: string;
  layerCount: number;
  textLayerCount: number;
  imageLayerCount: number;
};

export type MaterializedCompositionTemplate = {
  template: CompositionTemplateSummary;
  layers: CompositionLayer[];
  copiedRelativePaths: string[];
};

export type CompositionTemplateServiceOptions = {
  createId?: () => string;
  createAssetId?: () => string;
  now?: () => Date | string;
};

function errno(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateTemplateId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BackendError("Invalid composition template ID.", 400, "INVALID_TEMPLATE_ID");
  }
  return value;
}

function normalizeTemplateName(value: unknown) {
  if (typeof value !== "string") {
    throw new BackendError("A template name is required.", 400, "INVALID_TEMPLATE_NAME");
  }
  const name = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_TEMPLATE_NAME_LENGTH) {
    throw new BackendError(
      `A template name must be between 1 and ${MAX_TEMPLATE_NAME_LENGTH} characters.`,
      400,
      "INVALID_TEMPLATE_NAME",
    );
  }
  return name;
}

function validateTimestamp(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Invalid composition template timestamp.");
  }
  return value;
}

function validateTemplateSource(value: unknown): TemplateImageSource {
  const candidate = record(value);
  if (candidate?.kind === "builtin" && candidate.key === "gostudy-logo") {
    return { kind: "builtin", key: "gostudy-logo" };
  }
  if (candidate?.kind === "asset") {
    return { kind: "asset", assetId: validateTemplateId(candidate.assetId) };
  }
  throw new Error("Invalid composition template image source.");
}

function storedImageLayer(layer: ImageLayer, source: TemplateImageSource): StoredTemplateImageLayer {
  return {
    id: layer.id,
    type: "image",
    role: layer.role,
    name: layer.name,
    source,
    x: layer.x,
    y: layer.y,
    width: layer.width,
    aspectRatio: layer.aspectRatio,
    mask: layer.mask,
  };
}

function validateStoredTemplate(
  value: unknown,
  expectedOwnerId: string,
  expectedTemplateId: string,
) {
  const envelope = record(value);
  const template = record(envelope?.template);
  if (
    envelope?.storageVersion !== 1 ||
    envelope.ownerId !== expectedOwnerId ||
    !template ||
    template.version !== COMPOSITION_TEMPLATE_VERSION ||
    template.id !== expectedTemplateId ||
    template.framePreset !== "onetake-v1" ||
    !Array.isArray(template.layers)
  ) {
    throw new Error("Invalid composition template record.");
  }

  const sources = new Map<number, TemplateImageSource>();
  const layersForValidation = template.layers.map((rawLayer, index) => {
    const layer = record(rawLayer);
    if (layer?.type !== "image") return rawLayer;
    const source = validateTemplateSource(layer.source);
    sources.set(index, source);
    return { ...layer, source: undefined, src: DEFAULT_LOGO_SRC };
  });
  const validatedLayers = validateCompositionLayers(layersForValidation, {
    code: "CORRUPT_COMPOSITION_TEMPLATE",
  });
  const layers = validatedLayers.map((layer, index): StoredTemplateLayer => {
    if (layer.type === "text") return layer;
    const source = sources.get(index);
    if (!source) throw new Error("A composition template image source is missing.");
    return storedImageLayer(layer, source);
  });

  return {
    version: COMPOSITION_TEMPLATE_VERSION,
    id: validateTemplateId(template.id),
    name: normalizeTemplateName(template.name),
    framePreset: "onetake-v1" as const,
    createdAt: validateTimestamp(template.createdAt),
    updatedAt: validateTimestamp(template.updatedAt),
    layers,
  } satisfies StoredCompositionTemplate;
}

function summary(template: StoredCompositionTemplate): CompositionTemplateSummary {
  const textLayerCount = template.layers.filter((layer) => layer.type === "text").length;
  return {
    version: COMPOSITION_TEMPLATE_VERSION,
    id: template.id,
    name: template.name,
    framePreset: template.framePreset,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    layerCount: template.layers.length,
    textLayerCount,
    imageLayerCount: template.layers.length - textLayerCount,
  };
}

function compareTemplates(left: StoredCompositionTemplate, right: StoredCompositionTemplate) {
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated;
  const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return created || left.id.localeCompare(right.id);
}

export class CompositionTemplateService {
  private readonly templatesDirectory: string;
  private readonly createId: () => string;
  private readonly createAssetId: () => string;
  private readonly clock: () => Date | string;
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(
    dataDirectory: string,
    private readonly media: MediaStorage,
    options: CompositionTemplateServiceOptions = {},
  ) {
    this.templatesDirectory = join(dataDirectory, "composition-templates");
    this.createId = options.createId ?? randomUUID;
    this.createAssetId = options.createAssetId ?? randomUUID;
    this.clock = options.now ?? (() => new Date());
  }

  async initialize() {
    await mkdir(this.templatesDirectory, { recursive: true, mode: 0o700 });
    const owners = await readdir(this.templatesDirectory, { withFileTypes: true });
    for (const owner of owners) {
      if (!owner.isDirectory() || !UUID_PATTERN.test(owner.name)) continue;
      const ownerDirectory = join(this.templatesDirectory, owner.name);
      const entries = await readdir(ownerDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          await rm(join(ownerDirectory, entry.name), { recursive: true, force: true });
          continue;
        }
        if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
        const templateDirectory = join(ownerDirectory, entry.name);
        const files = await readdir(templateDirectory, { withFileTypes: true });
        await Promise.all(files
          .filter((file) => file.isFile() && file.name.startsWith(`.${TEMPLATE_FILENAME}.`))
          .map((file) => rm(join(templateDirectory, file.name), { force: true })));
      }
    }
  }

  private ownerDirectory(ownerId: string) {
    return join(this.templatesDirectory, validateOwnerId(ownerId));
  }

  private templateDirectory(ownerId: string, templateId: string) {
    return join(this.ownerDirectory(ownerId), validateTemplateId(templateId));
  }

  private templatePath(ownerId: string, templateId: string) {
    return join(this.templateDirectory(ownerId, templateId), TEMPLATE_FILENAME);
  }

  private assetPath(ownerId: string, templateId: string, assetId: string) {
    return join(
      this.templateDirectory(ownerId, templateId),
      "assets",
      `${validateTemplateId(assetId)}.png`,
    );
  }

  private now() {
    const value = this.clock();
    const timestamp = value instanceof Date ? value.toISOString() : value;
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
      throw new BackendError("The template clock returned an invalid timestamp.", 500, "INVALID_CLOCK");
    }
    return timestamp;
  }

  private nextTimestamp(previous: string) {
    const candidate = this.now();
    return Date.parse(candidate) > Date.parse(previous)
      ? candidate
      : new Date(Date.parse(previous) + 1).toISOString();
  }

  private async serialize<T>(ownerId: string, operation: () => Promise<T>) {
    const key = validateOwnerId(ownerId);
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.mutations.set(key, current);
    try {
      return await current;
    } finally {
      if (this.mutations.get(key) === current) this.mutations.delete(key);
    }
  }

  private async read(ownerId: string, templateId: string) {
    const ownerDirectory = this.ownerDirectory(ownerId);
    const templateDirectory = this.templateDirectory(ownerId, templateId);
    const templatePath = this.templatePath(ownerId, templateId);
    let contents: string;
    try {
      const [ownerMetadata, templateMetadata, documentMetadata] = await Promise.all([
        lstat(ownerDirectory),
        lstat(templateDirectory),
        lstat(templatePath),
      ]);
      if (
        !ownerMetadata.isDirectory() || ownerMetadata.isSymbolicLink() ||
        !templateMetadata.isDirectory() || templateMetadata.isSymbolicLink() ||
        !documentMetadata.isFile() || documentMetadata.isSymbolicLink()
      ) {
        throw new Error("Unsafe composition template path.");
      }
      contents = await readFile(templatePath, "utf8");
    } catch (error) {
      if (errno(error, "ENOENT")) return undefined;
      throw new BackendError(
        "The composition template record could not be read.",
        500,
        "CORRUPT_COMPOSITION_TEMPLATE",
      );
    }

    try {
      const value = JSON.parse(contents);
      const template = validateStoredTemplate(value, ownerId, templateId);
      const assetIds = new Set(template.layers.flatMap((layer) =>
        layer.type === "image" && layer.source.kind === "asset"
          ? [layer.source.assetId]
          : [],
      ));
      let totalAssetBytes = 0;
      const assetsDirectory = join(templateDirectory, "assets");
      const assetsMetadata = await lstat(assetsDirectory);
      if (!assetsMetadata.isDirectory() || assetsMetadata.isSymbolicLink()) {
        throw new Error("Unsafe composition template assets path.");
      }
      for (const assetId of assetIds) {
        const metadata = await lstat(this.assetPath(ownerId, templateId, assetId));
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
          throw new Error("Invalid composition template asset.");
        }
        totalAssetBytes += metadata.size;
        if (totalAssetBytes > MAX_TEMPLATE_ASSET_BYTES) {
          throw new Error("Composition template assets exceed the size limit.");
        }
      }
      return template;
    } catch {
      throw new BackendError(
        "The composition template record could not be read.",
        500,
        "CORRUPT_COMPOSITION_TEMPLATE",
      );
    }
  }

  private async listUnlocked(ownerId: string) {
    let entries;
    try {
      entries = await readdir(this.ownerDirectory(ownerId), { withFileTypes: true });
    } catch (error) {
      if (errno(error, "ENOENT")) return [];
      throw error;
    }

    const templates: StoredCompositionTemplate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || !UUID_PATTERN.test(entry.name)) {
        continue;
      }
      const template = await this.read(ownerId, entry.name);
      if (template) templates.push(template);
    }
    return templates.sort(compareTemplates);
  }

  private envelope(ownerId: string, template: StoredCompositionTemplate): TemplateEnvelope {
    return { storageVersion: 1, ownerId: validateOwnerId(ownerId), template };
  }

  private async atomicWrite(ownerId: string, template: StoredCompositionTemplate) {
    const directory = this.templateDirectory(ownerId, template.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new BackendError(
        "The composition template directory is unsafe.",
        500,
        "UNSAFE_TEMPLATE_DIRECTORY",
      );
    }
    const temporary = join(directory, `.${TEMPLATE_FILENAME}.${randomUUID()}.tmp`);
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(this.envelope(ownerId, template), null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(temporary, this.templatePath(ownerId, template.id));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return template;
  }

  async list(ownerId: string) {
    validateOwnerId(ownerId);
    return (await this.listUnlocked(ownerId)).map(summary);
  }

  async get(ownerId: string, templateId: string) {
    validateOwnerId(ownerId);
    validateTemplateId(templateId);
    const template = await this.read(ownerId, templateId);
    if (!template) {
      throw new BackendError("Composition template not found.", 404, "TEMPLATE_NOT_FOUND");
    }
    return template;
  }

  async capture(input: {
    ownerId: string;
    sourceProjectId: string;
    name: unknown;
    layers: unknown;
  }) {
    const ownerId = validateOwnerId(input.ownerId);
    const sourceProjectId = validateProjectId(input.sourceProjectId);
    const name = normalizeTemplateName(input.name);
    const layers = validateCompositionLayers(input.layers, {
      code: "INVALID_COMPOSITION_TEMPLATE",
      projectId: sourceProjectId,
    });

    return this.serialize(ownerId, async () => {
      if ((await this.listUnlocked(ownerId)).length >= MAX_COMPOSITION_TEMPLATES_PER_OWNER) {
        throw new BackendError(
          `An account can have at most ${MAX_COMPOSITION_TEMPLATES_PER_OWNER} composition templates.`,
          409,
          "TEMPLATE_LIMIT_REACHED",
        );
      }
      const id = validateTemplateId(this.createId());
      if (await this.read(ownerId, id)) {
        throw new BackendError("The composition template already exists.", 409, "TEMPLATE_EXISTS");
      }

      const ownerDirectory = this.ownerDirectory(ownerId);
      await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
      const ownerMetadata = await lstat(ownerDirectory);
      if (!ownerMetadata.isDirectory() || ownerMetadata.isSymbolicLink()) {
        throw new BackendError(
          "The composition template directory is unsafe.",
          500,
          "UNSAFE_TEMPLATE_DIRECTORY",
        );
      }
      const stagingDirectory = join(ownerDirectory, `.${id}.${randomUUID()}.tmp`);
      const stagingAssetsDirectory = join(stagingDirectory, "assets");
      await mkdir(stagingAssetsDirectory, { recursive: true, mode: 0o700 });
      const assetsByPath = new Map<string, string>();
      let totalAssetBytes = 0;

      try {
        const storedLayers: StoredTemplateLayer[] = [];
        for (const layer of layers) {
          if (layer.type === "text") {
            storedLayers.push(layer);
            continue;
          }
          if (layer.src === DEFAULT_LOGO_SRC) {
            storedLayers.push(storedImageLayer(layer, { kind: "builtin", key: "gostudy-logo" }));
            continue;
          }

          const parsed = parseLocalMediaUrl(layer.src, sourceProjectId);
          let assetId = assetsByPath.get(parsed.relativePath);
          if (!assetId) {
            assetId = validateTemplateId(this.createAssetId());
            const source = await this.media.resolveFile(parsed.relativePath);
            totalAssetBytes += source.size;
            if (totalAssetBytes > MAX_TEMPLATE_ASSET_BYTES) {
              throw new BackendError(
                "The images in this composition are too large to save as one template.",
                413,
                "TEMPLATE_ASSETS_TOO_LARGE",
              );
            }
            await copyFile(source.path, join(stagingAssetsDirectory, `${assetId}.png`));
            assetsByPath.set(parsed.relativePath, assetId);
          }
          storedLayers.push(storedImageLayer(layer, { kind: "asset", assetId }));
        }

        const timestamp = this.now();
        const template: StoredCompositionTemplate = {
          version: COMPOSITION_TEMPLATE_VERSION,
          id,
          name,
          framePreset: "onetake-v1",
          createdAt: timestamp,
          updatedAt: timestamp,
          layers: storedLayers,
        };
        await writeFile(
          join(stagingDirectory, TEMPLATE_FILENAME),
          `${JSON.stringify(this.envelope(ownerId, template), null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        await rename(stagingDirectory, this.templateDirectory(ownerId, id));
        return summary(template);
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async rename(ownerId: string, templateId: string, name: unknown, expectedUpdatedAt?: unknown) {
    const normalizedOwnerId = validateOwnerId(ownerId);
    const normalizedTemplateId = validateTemplateId(templateId);
    const normalizedName = normalizeTemplateName(name);
    return this.serialize(normalizedOwnerId, async () => {
      const current = await this.get(normalizedOwnerId, normalizedTemplateId);
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== current.updatedAt) {
        throw new BackendError(
          "This composition template changed in another session. Refresh and try again.",
          409,
          "TEMPLATE_CONFLICT",
        );
      }
      if (current.name === normalizedName) return summary(current);
      const updated = await this.atomicWrite(normalizedOwnerId, {
        ...current,
        name: normalizedName,
        updatedAt: this.nextTimestamp(current.updatedAt),
      });
      return summary(updated);
    });
  }

  async delete(ownerId: string, templateId: string) {
    const normalizedOwnerId = validateOwnerId(ownerId);
    const normalizedTemplateId = validateTemplateId(templateId);
    return this.serialize(normalizedOwnerId, async () => {
      const directory = this.templateDirectory(normalizedOwnerId, normalizedTemplateId);
      try {
        const [ownerMetadata, metadata] = await Promise.all([
          lstat(this.ownerDirectory(normalizedOwnerId)),
          lstat(directory),
        ]);
        if (
          !ownerMetadata.isDirectory() || ownerMetadata.isSymbolicLink() ||
          !metadata.isDirectory() || metadata.isSymbolicLink()
        ) {
          throw new BackendError(
            "The composition template record could not be read.",
            500,
            "CORRUPT_COMPOSITION_TEMPLATE",
          );
        }
      } catch (error) {
        if (errno(error, "ENOENT")) {
          throw new BackendError("Composition template not found.", 404, "TEMPLATE_NOT_FOUND");
        }
        throw error;
      }
      const tombstone = join(
        this.ownerDirectory(normalizedOwnerId),
        `.${normalizedTemplateId}.${randomUUID()}.deleted`,
      );
      await rename(directory, tombstone);
      await rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
      return true;
    });
  }

  async materialize(ownerId: string, templateId: string, targetProjectId: string) {
    const normalizedOwnerId = validateOwnerId(ownerId);
    const normalizedTemplateId = validateTemplateId(templateId);
    const normalizedProjectId = validateProjectId(targetProjectId);
    return this.serialize(normalizedOwnerId, async () => {
      const template = await this.get(normalizedOwnerId, normalizedTemplateId);
      const urlsByAssetId = new Map<string, string>();
      const copiedRelativePaths: string[] = [];
      let totalAssetBytes = 0;
      try {
        const layers: CompositionLayer[] = [];
        for (const layer of template.layers) {
          if (layer.type === "text") {
            layers.push({ ...layer });
            continue;
          }
          if (layer.source.kind === "builtin") {
            layers.push({ ...layer, src: DEFAULT_LOGO_SRC, source: undefined } as ImageLayer);
            continue;
          }

          let url = urlsByAssetId.get(layer.source.assetId);
          if (!url) {
            let bytes: Buffer;
            try {
              const path = this.assetPath(normalizedOwnerId, normalizedTemplateId, layer.source.assetId);
              const metadata = await lstat(path);
              totalAssetBytes += metadata.size;
              if (
                !metadata.isFile() ||
                metadata.isSymbolicLink() ||
                metadata.size <= 0 ||
                totalAssetBytes > MAX_TEMPLATE_ASSET_BYTES
              ) {
                throw new Error("Invalid template asset.");
              }
              bytes = await readFile(path);
            } catch {
              throw new BackendError(
                "A saved image in this composition template is unavailable.",
                500,
                "CORRUPT_TEMPLATE_ASSET",
              );
            }
            const uploaded = await this.media.storeUploadedImage({
              projectId: normalizedProjectId,
              bytes,
            }).catch(() => {
              throw new BackendError(
                "A saved image in this composition template is invalid.",
                500,
                "CORRUPT_TEMPLATE_ASSET",
              );
            });
            url = uploaded.url;
            urlsByAssetId.set(layer.source.assetId, url);
            copiedRelativePaths.push(parseLocalMediaUrl(url, normalizedProjectId).relativePath);
          }
          layers.push({ ...layer, src: url, source: undefined } as ImageLayer);
        }
        return {
          template: summary(template),
          layers: validateCompositionLayers(layers, {
            code: "CORRUPT_COMPOSITION_TEMPLATE",
            projectId: normalizedProjectId,
          }),
          copiedRelativePaths,
        } satisfies MaterializedCompositionTemplate;
      } catch (error) {
        await Promise.allSettled(copiedRelativePaths.map((path) => this.media.deleteFile(path)));
        throw error;
      }
    });
  }

  async discardMaterialized(application: MaterializedCompositionTemplate) {
    await Promise.allSettled(
      application.copiedRelativePaths.map((path) => this.media.deleteFile(path)),
    );
  }
}
