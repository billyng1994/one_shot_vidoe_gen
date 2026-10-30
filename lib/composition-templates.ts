import {
  FONT_FAMILIES,
  imageLayerHeight,
  MAX_COMPOSITION_LAYERS,
  MAX_BACKGROUND_ASPECT_RATIO,
  maximumImageLayerWidth,
  MIN_BACKGROUND_ASPECT_RATIO,
  MIN_IMAGE_LAYER_WIDTH,
  minimumImageLayerWidth,
  textLayerHeight,
  type CompositionLayer,
  type FontFamily,
  type FontWeight,
  type ImageLayer,
  type TextAlignment,
  type TextLayer,
} from "./composition";

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

export type CompositionTemplateDetail = CompositionTemplateSummary & {
  layers: CompositionLayer[];
};

export type CompositionTemplateAssetUpload = {
  assetId: string;
  url: string;
  width: number;
  height: number;
};

const TEMPLATE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEMPLATE_NAME_LENGTH = 80;
const MAX_TEMPLATES_PER_ACCOUNT = 50;

export function isCompositionTemplateId(value: unknown): value is string {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value);
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COMPOSITION_LAYERS
  );
}

function validTemplateName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEMPLATE_NAME_LENGTH) {
    return false;
  }
  return value.normalize("NFKC").trim().replace(/\s+/g, " ") === value;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type ValidLayerBase = Record<string, unknown> & {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
};

function validLayerBase(candidate: Record<string, unknown>): candidate is ValidLayerBase {
  return (
    typeof candidate.id === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(candidate.id) &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    candidate.name.length <= 60 &&
    candidate.name.trim() === candidate.name &&
    finiteNumber(candidate.x) &&
    finiteNumber(candidate.y) &&
    finiteNumber(candidate.width)
  );
}

function validDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 40_000;
}

function parseTextLayer(value: unknown): TextLayer | null {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.type !== "text" ||
    !validLayerBase(candidate) ||
    typeof candidate.text !== "string" ||
    candidate.text.length > 500 ||
    candidate.width < 0.12 ||
    candidate.width > 0.96 ||
    candidate.x < 0 ||
    candidate.x > 1 - candidate.width ||
    candidate.y < 0 ||
    !finiteNumber(candidate.fontSize) ||
    candidate.fontSize < 18 ||
    candidate.fontSize > 180 ||
    typeof candidate.fontFamily !== "string" ||
    !Object.prototype.hasOwnProperty.call(FONT_FAMILIES, candidate.fontFamily) ||
    (candidate.fontWeight !== 400 && candidate.fontWeight !== 700 && candidate.fontWeight !== 900) ||
    typeof candidate.color !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(candidate.color) ||
    typeof candidate.strokeColor !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(candidate.strokeColor) ||
    !finiteNumber(candidate.strokeWidth) ||
    candidate.strokeWidth < 0 ||
    candidate.strokeWidth > 20 ||
    (candidate.textAlign !== "left" &&
      candidate.textAlign !== "center" &&
      candidate.textAlign !== "right")
  ) {
    return null;
  }

  const layer: TextLayer = {
    id: candidate.id,
    type: "text",
    name: candidate.name,
    text: candidate.text,
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    fontSize: candidate.fontSize,
    fontFamily: candidate.fontFamily as FontFamily,
    fontWeight: candidate.fontWeight as FontWeight,
    color: candidate.color.toLowerCase(),
    strokeColor: candidate.strokeColor.toLowerCase(),
    strokeWidth: candidate.strokeWidth,
    textAlign: candidate.textAlign as TextAlignment,
  };
  return layer.y <= 1 - textLayerHeight(layer) ? layer : null;
}

function templateAssetUrl(value: unknown, templateId: string) {
  if (typeof value !== "string") return null;
  const assetPattern =
    `/api/composition-templates/${templateId}/assets/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})`;
  return new RegExp(`^${assetPattern}$`, "i").test(value) ? value : null;
}

export function parseCompositionTemplateAssetUpload(
  value: unknown,
  templateId: string,
): CompositionTemplateAssetUpload | null {
  const candidate = record(value);
  const url = typeof candidate?.url === "string" ? candidate.url : "";
  if (
    !candidate ||
    !isCompositionTemplateId(templateId) ||
    !isCompositionTemplateId(candidate.assetId) ||
    templateAssetUrl(url, templateId) !== url ||
    url !== `/api/composition-templates/${templateId}/assets/${candidate.assetId}` ||
    !validDimension(candidate.width) ||
    !validDimension(candidate.height)
  ) {
    return null;
  }
  return {
    assetId: candidate.assetId,
    url,
    width: candidate.width,
    height: candidate.height,
  };
}

function parseImageLayer(value: unknown, templateId: string): ImageLayer | null {
  const candidate = record(value);
  const role = candidate?.role;
  const src = candidate?.src === "/gostudy-logo.svg"
    ? candidate.src
    : templateAssetUrl(candidate?.src, templateId);
  if (
    !candidate ||
    candidate.type !== "image" ||
    !validLayerBase(candidate) ||
    (role !== "background" && role !== "logo" && role !== "overlay") ||
    !src ||
    !finiteNumber(candidate.aspectRatio) ||
    candidate.aspectRatio < 0.01 ||
    candidate.aspectRatio > 100 ||
    (candidate.mask !== "none" && candidate.mask !== "circle")
  ) {
    return null;
  }

  if (src === "/gostudy-logo.svg" && role !== "logo") return null;
  const layer = {
    id: candidate.id,
    type: "image",
    role,
    name: candidate.name,
    src,
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    aspectRatio: candidate.aspectRatio,
    mask: candidate.mask,
  } as ImageLayer;

  const height = imageLayerHeight(layer);
  if (role === "background") {
    return layer.aspectRatio >= MIN_BACKGROUND_ASPECT_RATIO &&
      layer.aspectRatio <= MAX_BACKGROUND_ASPECT_RATIO &&
      layer.mask === "none" &&
      layer.width >= minimumImageLayerWidth(layer) &&
      layer.width <= maximumImageLayerWidth(layer) &&
      layer.x >= 1 - layer.width &&
      layer.x <= 0 &&
      layer.y >= 1 - height &&
      layer.y <= 0
      ? layer
      : null;
  }

  return layer.width >= MIN_IMAGE_LAYER_WIDTH &&
    layer.width <= maximumImageLayerWidth(layer) &&
    layer.x >= 0 &&
    layer.x <= 1 - layer.width &&
    layer.y >= 0 &&
    layer.y <= 1 - height
    ? layer
    : null;
}

export function parseCompositionTemplateSummary(
  value: unknown,
): CompositionTemplateSummary | null {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.version !== 1 ||
    typeof candidate.id !== "string" ||
    !TEMPLATE_ID_PATTERN.test(candidate.id) ||
    !validTemplateName(candidate.name) ||
    candidate.framePreset !== "onetake-v1" ||
    !validTimestamp(candidate.createdAt) ||
    !validTimestamp(candidate.updatedAt) ||
    !validCount(candidate.layerCount) ||
    candidate.layerCount < 1 ||
    !validCount(candidate.textLayerCount) ||
    !validCount(candidate.imageLayerCount) ||
    candidate.imageLayerCount < 1 ||
    candidate.textLayerCount + candidate.imageLayerCount !== candidate.layerCount
  ) {
    return null;
  }

  return {
    version: 1,
    id: candidate.id,
    name: candidate.name,
    framePreset: "onetake-v1",
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    layerCount: candidate.layerCount,
    textLayerCount: candidate.textLayerCount,
    imageLayerCount: candidate.imageLayerCount,
  };
}

export function parseCompositionTemplateDetail(
  value: unknown,
): CompositionTemplateDetail | null {
  const summary = parseCompositionTemplateSummary(value);
  const candidate = record(value);
  if (!summary || !candidate || !Array.isArray(candidate.layers)) return null;

  const layers: CompositionLayer[] = [];
  const ids = new Set<string>();
  for (const value of candidate.layers) {
    const layer = record(value)?.type === "text"
      ? parseTextLayer(value)
      : parseImageLayer(value, summary.id);
    if (!layer || ids.has(layer.id)) return null;
    ids.add(layer.id);
    layers.push(layer);
  }

  const textLayerCount = layers.filter(({ type }) => type === "text").length;
  const imageLayers = layers.filter((layer): layer is ImageLayer => layer.type === "image");
  const backgrounds = imageLayers.filter(({ role }) => role === "background");
  const logoCount = imageLayers.filter(({ role }) => role === "logo").length;
  if (
    layers.length !== summary.layerCount ||
    textLayerCount !== summary.textLayerCount ||
    imageLayers.length !== summary.imageLayerCount ||
    logoCount !== 1 ||
    backgrounds.length > 1 ||
    (backgrounds.length === 1 && layers[0]?.id !== backgrounds[0]?.id)
  ) {
    return null;
  }

  return { ...summary, layers };
}

export function parseCompositionTemplateList(
  value: unknown,
): CompositionTemplateSummary[] | null {
  const response = record(value);
  if (
    !Array.isArray(response?.templates) ||
    response.templates.length > MAX_TEMPLATES_PER_ACCOUNT
  ) {
    return null;
  }

  const templates: CompositionTemplateSummary[] = [];
  const ids = new Set<string>();
  for (const value of response.templates) {
    const template = parseCompositionTemplateSummary(value);
    const normalizedId = template?.id.toLowerCase();
    if (!template || !normalizedId || ids.has(normalizedId)) return null;
    ids.add(normalizedId);
    templates.push(template);
  }
  return templates;
}
