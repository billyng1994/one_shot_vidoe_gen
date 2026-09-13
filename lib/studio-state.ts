import {
  clampNumber,
  createDefaultLayers,
  createDefaultLogoLayer,
  DEFAULT_LOGO_SRC,
  DEFAULT_TITLE,
  FONT_FAMILIES,
  imageLayerHeight,
  isHexColor,
  MAX_IMAGE_ASPECT_RATIO,
  MAX_COMPOSITION_LAYERS,
  maximumImageLayerWidth,
  MIN_IMAGE_ASPECT_RATIO,
  MIN_IMAGE_LAYER_WIDTH,
  positionLayer,
  textLayerFromTitle,
  type CompositionLayer,
  type FontFamily,
  type FontWeight,
  type ImageLayer,
  type ImageMask,
  type TextAlignment,
  type TextLayer,
  type TitlePlacement,
} from "./composition";

export type PersistedAsset = {
  requestId: string;
  url: string;
};

export type StudioSnapshot = {
  version: 2;
  step: 1 | 2 | 3;
  imagePrompt: string;
  motionPrompt: string;
  image: PersistedAsset;
  video: PersistedAsset;
  duration: 5 | 8 | 10;
  resolution: "720" | "1080";
  cameraFixed: boolean;
  layers: CompositionLayer[];
  musicVolume: number;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeRequestId(value: unknown, kind: "image" | "video") {
  if (typeof value !== "string") return "";
  const backendPattern = new RegExp(
    `^gen-${kind}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "i",
  );
  const cliPattern = new RegExp(
    `^cli-${kind}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "i",
  );
  const demoPattern = new RegExp(`^demo-${kind}-\\d+$`);
  return backendPattern.test(value) || cliPattern.test(value) || demoPattern.test(value)
    ? value
    : "";
}

function safeMediaUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4_096) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  try {
    return new URL(value).protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

function safeLayerImageUrl(value: unknown) {
  if (value === DEFAULT_LOGO_SRC) return value;
  if (typeof value !== "string" || value.length > 512) return "";
  return /^\/media\/(?:legacy-v1|[0-9a-f-]{36})\/images\/overlay-[0-9a-f-]{36}\.png$/i.test(
    value,
  )
    ? value
    : "";
}

function asset(value: unknown, kind: "image" | "video"): PersistedAsset {
  const candidate = record(value);
  return {
    requestId: safeRequestId(candidate?.requestId, kind),
    url: safeMediaUrl(candidate?.url),
  };
}

function layerId(value: unknown, fallback: string) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
    ? value
    : fallback;
}

function layerName(value: unknown, fallback: string) {
  return boundedString(value, 60).trim().replace(/\s+/g, " ") || fallback;
}

function fontFamily(value: unknown): FontFamily {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FONT_FAMILIES, value)
    ? value as FontFamily
    : "sans";
}

function fontWeight(value: unknown): FontWeight {
  return value === 400 || value === 900 ? value : 700;
}

function textAlignment(value: unknown): TextAlignment {
  return value === "center" || value === "right" ? value : "left";
}

function imageMask(value: unknown): ImageMask {
  return value === "circle" ? "circle" : "none";
}

function normalizeTextLayer(value: Record<string, unknown>, index: number): TextLayer {
  const width = clampNumber(finiteNumber(value.width, 0.8), 0.12, 0.96);
  const layer: TextLayer = {
    id: layerId(value.id, `text-${index + 1}`),
    type: "text",
    name: layerName(value.name, `Text ${index + 1}`),
    text: boundedString(value.text, 500),
    x: finiteNumber(value.x, 0.1),
    y: finiteNumber(value.y, 0.24),
    width,
    fontSize: clampNumber(finiteNumber(value.fontSize, 64), 18, 180),
    fontFamily: fontFamily(value.fontFamily),
    fontWeight: fontWeight(value.fontWeight),
    color: isHexColor(value.color) ? value.color.toLowerCase() : "#ffffff",
    strokeColor: isHexColor(value.strokeColor)
      ? value.strokeColor.toLowerCase()
      : "#191816",
    strokeWidth: clampNumber(finiteNumber(value.strokeWidth, 4), 0, 20),
    textAlign: textAlignment(value.textAlign),
  };

  return positionLayer(layer, layer.x, layer.y);
}

function normalizeImageLayer(value: Record<string, unknown>, index: number): ImageLayer | null {
  const src = safeLayerImageUrl(value.src);
  if (!src) return null;
  const role = value.role === "logo" ? "logo" : "overlay";
  const mask = imageMask(value.mask);
  const aspectRatio = clampNumber(
    finiteNumber(value.aspectRatio, 1),
    MIN_IMAGE_ASPECT_RATIO,
    MAX_IMAGE_ASPECT_RATIO,
  );
  const largestWidth = maximumImageLayerWidth({ mask, aspectRatio });
  const width = clampNumber(
    finiteNumber(value.width, role === "logo" ? 0.267 : 0.24),
    MIN_IMAGE_LAYER_WIDTH,
    largestWidth,
  );
  const provisional: ImageLayer = {
    id: layerId(value.id, `image-${index + 1}`),
    type: "image" as const,
    role,
    name: layerName(value.name, role === "logo" ? "Brand logo" : `Image ${index + 1}`),
    src,
    x: 0,
    y: 0,
    width,
    aspectRatio,
    mask,
  };
  const height = imageLayerHeight(provisional);
  return {
    ...provisional,
    x: clampNumber(finiteNumber(value.x, 0.38), 0, 1 - width),
    y: clampNumber(finiteNumber(value.y, role === "logo" ? 0.02 : 0.32), 0, 1 - height),
  };
}

function normalizeLayers(value: unknown) {
  if (!Array.isArray(value)) return createDefaultLayers();
  const seen = new Set<string>();
  let foundLogo = false;
  const layers: CompositionLayer[] = [];

  for (const [index, rawLayer] of value.slice(0, MAX_COMPOSITION_LAYERS).entries()) {
    const candidate = record(rawLayer);
    if (!candidate) continue;
    let layer: CompositionLayer | null = null;
    if (candidate.type === "text") layer = normalizeTextLayer(candidate, index);
    if (candidate.type === "image") layer = normalizeImageLayer(candidate, index);
    if (!layer) continue;
    if (layer.type === "image" && layer.role === "logo") {
      if (foundLogo) {
        layer = { ...layer, id: `image-${index + 1}`, role: "overlay" };
      } else {
        layer = { ...layer, id: "brand-logo" };
        foundLogo = true;
      }
    } else if (layer.id === "brand-logo") {
      layer = { ...layer, id: `${layer.type}-${index + 1}` };
    }
    if (seen.has(layer.id)) continue;
    seen.add(layer.id);
    layers.push(layer);
  }

  if (!foundLogo) layers.unshift(createDefaultLogoLayer());
  return layers.slice(0, MAX_COMPOSITION_LAYERS);
}

function legacyTitle(value: unknown): TitlePlacement {
  const title = record(value);
  return {
    text: boundedString(title?.text, 180) || DEFAULT_TITLE.text,
    x: clampNumber(finiteNumber(title?.x, DEFAULT_TITLE.x), 0.02, 0.82),
    y: clampNumber(finiteNumber(title?.y, DEFAULT_TITLE.y), 0.13, 0.84),
    fontSize: clampNumber(finiteNumber(title?.fontSize, DEFAULT_TITLE.fontSize), 48, 132),
  };
}

export function serializeStudioSnapshot(snapshot: StudioSnapshot) {
  return JSON.stringify(snapshot);
}

export function parseStudioSnapshot(value: string | null): StudioSnapshot | null {
  if (!value) return null;

  try {
    const parsed = record(JSON.parse(value));
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2)) return null;

    const image = asset(parsed.image, "image");
    const video = asset(parsed.video, "video");
    const requestedStep = parsed.step === 2 || parsed.step === 3 ? parsed.step : 1;
    const step = !image.url ? 1 : requestedStep === 3 && !video.url ? 2 : requestedStep;
    const duration = parsed.duration === 8 || parsed.duration === 10 ? parsed.duration : 5;
    const resolution = parsed.resolution === "1080" ? "1080" : "720";
    const layers = parsed.version === 1
      ? [createDefaultLogoLayer(), textLayerFromTitle(legacyTitle(parsed.title))]
      : normalizeLayers(parsed.layers);

    return {
      version: 2,
      step,
      imagePrompt: boundedString(parsed.imagePrompt, 4_000),
      motionPrompt: boundedString(parsed.motionPrompt, 4_000),
      image,
      video,
      duration,
      resolution,
      cameraFixed: parsed.cameraFixed === true,
      layers,
      musicVolume: clampNumber(finiteNumber(parsed.musicVolume, 0.24), 0, 1),
    };
  } catch {
    return null;
  }
}
