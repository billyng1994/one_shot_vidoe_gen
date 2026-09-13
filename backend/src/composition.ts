import { BackendError } from "./errors.js";
import { parseLocalMediaUrl } from "./validation.js";

export const OUTPUT_SIZE = { width: 1080, height: 1350 } as const;
export const MEDIA_RECT = { x: 0, y: 159, width: 1080, height: 1072 } as const;
export const BRAND_LOGO_RECT = { x: 400, y: 28, width: 288, height: 118 } as const;
export const DEFAULT_LOGO_SRC = "/gostudy-logo.svg" as const;
export const MAX_COMPOSITION_LAYERS = 20;
export const MAX_COMPOSITION_JSON_BYTES = 48 * 1024;
export const MIN_IMAGE_ASPECT_RATIO = 0.01;
export const MAX_IMAGE_ASPECT_RATIO = 100;
export const MIN_IMAGE_LAYER_WIDTH = 0.01;

export const FONT_FAMILIES = {
  sans: '"Liberation Sans", Arial, "Noto Sans CJK TC", "PingFang TC", sans-serif',
  display: '"Liberation Sans", Arial, "Noto Sans CJK TC", "PingFang TC", sans-serif',
  serif: '"Liberation Serif", "Times New Roman", "Noto Serif CJK TC", "Songti TC", serif',
  mono: '"Liberation Mono", "Courier New", "Noto Sans Mono CJK TC", monospace',
} as const;
export const FONT_WEIGHTS = [400, 700, 900] as const;
export const TEXT_ALIGNMENTS = ["left", "center", "right"] as const;
export const IMAGE_MASKS = ["none", "circle"] as const;

export type FontFamily = keyof typeof FONT_FAMILIES;
export type FontWeight = (typeof FONT_WEIGHTS)[number];
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];
export type ImageMask = (typeof IMAGE_MASKS)[number];

type LayerBase = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
};

export type TextLayer = LayerBase & {
  type: "text";
  text: string;
  fontSize: number;
  fontFamily: FontFamily;
  fontWeight: FontWeight;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  textAlign: TextAlignment;
};

export type ImageLayer = LayerBase & {
  type: "image";
  role: "logo" | "overlay";
  src: string;
  aspectRatio: number;
  mask: ImageMask;
};

export type CompositionLayer = TextLayer | ImageLayer;

export type CompositionDocument = {
  version: 1;
  layers: CompositionLayer[];
};

export type TitlePlacement = {
  text: string;
  x: number;
  y: number;
  fontSize: number;
};

export const DEFAULT_TITLE: TitlePlacement = {
  text: "Your story starts here",
  x: 0.055,
  y: 0.165,
  fontSize: 86,
};

const LAYER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const UPLOADED_IMAGE_FILENAME_PATTERN =
  /^overlay-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function invalid(message: string, code: string): never {
  throw new BackendError(message, 400, code);
}

function finiteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  code: string,
) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(`${label} is out of range.`, code);
  }
  return value;
}

function stringWithMaximum(value: unknown, maximum: number, label: string, code: string) {
  if (typeof value !== "string" || value.length > maximum) {
    invalid(`${label} must be at most ${maximum} characters.`, code);
  }
  return value;
}

function validateImageSource(value: unknown, expectedProjectId: string | undefined, code: string) {
  if (value === DEFAULT_LOGO_SRC) return value;
  let parsed: ReturnType<typeof parseLocalMediaUrl>;
  try {
    parsed = parseLocalMediaUrl(value, expectedProjectId);
  } catch {
    invalid("An image layer must use a project-owned uploaded image.", code);
  }
  if (parsed.category !== "images" || !UPLOADED_IMAGE_FILENAME_PATTERN.test(parsed.filename)) {
    invalid("An image layer must use a project-owned uploaded image.", code);
  }
  return value as string;
}

export function validateCompositionLayers(
  value: unknown,
  options: { code?: string; projectId?: string } = {},
): CompositionLayer[] {
  const code = options.code ?? "INVALID_COMPOSITION";
  if (!Array.isArray(value) || value.length > MAX_COMPOSITION_LAYERS) {
    invalid(`A composition must contain at most ${MAX_COMPOSITION_LAYERS} layers.`, code);
  }

  const ids = new Set<string>();
  const layers = value.map((rawLayer, index) => {
    const layer = record(rawLayer);
    if (!layer) invalid(`Composition layer ${index + 1} must be an object.`, code);
    if (typeof layer.id !== "string" || !LAYER_ID_PATTERN.test(layer.id)) {
      invalid(`Composition layer ${index + 1} has an invalid ID.`, code);
    }
    if (ids.has(layer.id)) invalid("Composition layer IDs must be unique.", code);
    ids.add(layer.id);

    const name = stringWithMaximum(layer.name, 60, "A layer name", code).trim();
    if (!name) invalid("A layer name is required.", code);

    if (layer.type === "text") {
      const text = stringWithMaximum(layer.text, 500, "Text layer content", code);
      if (
        typeof layer.fontFamily !== "string" ||
        !Object.prototype.hasOwnProperty.call(FONT_FAMILIES, layer.fontFamily)
      ) {
        invalid("A text layer has an invalid font family.", code);
      }
      if (!(FONT_WEIGHTS as readonly unknown[]).includes(layer.fontWeight)) {
        invalid("A text layer has an invalid font weight.", code);
      }
      if (!(TEXT_ALIGNMENTS as readonly unknown[]).includes(layer.textAlign)) {
        invalid("A text layer has an invalid alignment.", code);
      }
      if (typeof layer.color !== "string" || !COLOR_PATTERN.test(layer.color)) {
        invalid("A text layer has an invalid font color.", code);
      }
      if (typeof layer.strokeColor !== "string" || !COLOR_PATTERN.test(layer.strokeColor)) {
        invalid("A text layer has an invalid border color.", code);
      }
      const width = finiteInRange(layer.width, 0.12, 0.96, "A text layer width", code);
      const fontSize = finiteInRange(layer.fontSize, 18, 180, "A text layer font size", code);
      const provisional: TextLayer = {
        id: layer.id,
        type: "text" as const,
        name,
        text,
        x: 0,
        y: 0,
        width,
        fontSize,
        fontFamily: layer.fontFamily as FontFamily,
        fontWeight: layer.fontWeight as FontWeight,
        color: layer.color.toLowerCase(),
        strokeColor: layer.strokeColor.toLowerCase(),
        strokeWidth: finiteInRange(layer.strokeWidth, 0, 20, "A text layer border width", code),
        textAlign: layer.textAlign as TextAlignment,
      };
      return {
        ...provisional,
        x: finiteInRange(layer.x, 0, 1 - width, "A layer x position", code),
        y: finiteInRange(
          layer.y,
          0,
          Math.max(0, 1 - textLayerHeight(provisional)),
          "A layer y position",
          code,
        ),
      };
    }

    if (layer.type === "image") {
      if (layer.role !== "logo" && layer.role !== "overlay") {
        invalid("An image layer has an invalid role.", code);
      }
      if (!(IMAGE_MASKS as readonly unknown[]).includes(layer.mask)) {
        invalid("An image layer has an invalid mask.", code);
      }
      const aspectRatio = finiteInRange(
        layer.aspectRatio,
        MIN_IMAGE_ASPECT_RATIO,
        MAX_IMAGE_ASPECT_RATIO,
        "An image layer aspect ratio",
        code,
      );
      const mask = layer.mask as ImageMask;
      const maximumWidth = mask === "circle"
        ? 0.95
        : Math.min(0.95, 0.95 * aspectRatio * OUTPUT_SIZE.height / OUTPUT_SIZE.width);
      const width = finiteInRange(
        layer.width,
        MIN_IMAGE_LAYER_WIDTH,
        maximumWidth,
        "An image layer width",
        code,
      );
      const provisional: ImageLayer = {
        id: layer.id,
        type: "image" as const,
        name,
        role: layer.role,
        src: validateImageSource(layer.src, options.projectId, code),
        x: 0,
        y: 0,
        width,
        aspectRatio,
        mask,
      };
      return {
        ...provisional,
        x: finiteInRange(layer.x, 0, 1 - width, "A layer x position", code),
        y: finiteInRange(
          layer.y,
          0,
          Math.max(0, 1 - imageLayerHeight(provisional)),
          "A layer y position",
          code,
        ),
      };
    }

    invalid(`Composition layer ${index + 1} has an invalid type.`, code);
  });
  const logoCount = layers.filter(
    (layer) => layer.type === "image" && layer.role === "logo",
  ).length;
  if (logoCount !== 1) invalid("A composition must contain exactly one logo layer.", code);
  return layers;
}

export function validateCompositionDocument(
  value: unknown,
  options: { code?: string; projectId?: string } = {},
): CompositionDocument {
  const code = options.code ?? "INVALID_COMPOSITION";
  let parsed = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_COMPOSITION_JSON_BYTES) {
      invalid("The composition JSON is too large.", code);
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      invalid("The composition JSON is invalid.", code);
    }
  }
  if (Array.isArray(parsed)) {
    return { version: 1, layers: validateCompositionLayers(parsed, options) };
  }
  const candidate = record(parsed);
  if (!candidate || candidate.version !== 1) {
    invalid("The composition version is invalid.", code);
  }
  return {
    version: 1,
    layers: validateCompositionLayers(candidate.layers, options),
  };
}

export function defaultCompositionLayers(): CompositionLayer[] {
  return [
    {
      id: "brand-logo",
      type: "image",
      role: "logo",
      name: "Brand logo",
      src: DEFAULT_LOGO_SRC,
      x: BRAND_LOGO_RECT.x / OUTPUT_SIZE.width,
      y: BRAND_LOGO_RECT.y / OUTPUT_SIZE.height,
      width: BRAND_LOGO_RECT.width / OUTPUT_SIZE.width,
      aspectRatio: BRAND_LOGO_RECT.width / BRAND_LOGO_RECT.height,
      mask: "none",
    },
    textLayerFromLegacyTitle(DEFAULT_TITLE),
  ];
}

export function textLayerFromLegacyTitle(title: TitlePlacement): TextLayer {
  const layer: TextLayer = {
    id: "text-1",
    type: "text",
    name: "Text 1",
    text: title.text,
    x: title.x,
    y: title.y,
    width: 0.88,
    fontSize: title.fontSize,
    fontFamily: "display",
    fontWeight: 900,
    color: "#ff5423",
    strokeColor: "#fffdf9",
    strokeWidth: 10,
    textAlign: "left",
  };
  return {
    ...layer,
    x: clampNumber(layer.x, 0, 1 - layer.width),
    y: clampNumber(layer.y, 0, Math.max(0, 1 - textLayerHeight(layer))),
  };
}

export function legacyCompositionLayers(title: TitlePlacement): CompositionLayer[] {
  const [logo] = defaultCompositionLayers();
  return [logo!, textLayerFromLegacyTitle(title)];
}

export function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function imageLayerHeight(layer: ImageLayer) {
  const widthInPixels = layer.width * OUTPUT_SIZE.width;
  const heightInPixels = layer.mask === "circle"
    ? widthInPixels
    : widthInPixels / clampNumber(
        layer.aspectRatio,
        MIN_IMAGE_ASPECT_RATIO,
        MAX_IMAGE_ASPECT_RATIO,
      );
  return heightInPixels / OUTPUT_SIZE.height;
}

export function textLayerHeight(layer: TextLayer) {
  const fontSize = Math.round(clampNumber(layer.fontSize, 18, 180));
  const lineHeight = Math.round(fontSize * 1.08);
  const lineCount = wrappedTextLines(layer).length;
  return Math.min(0.96, (lineCount * lineHeight) / OUTPUT_SIZE.height);
}

export function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function characterWeight(character: string) {
  return /^[\x00-\x7F]$/.test(character) ? 0.56 : 1;
}

export function wrapTitle(text: string, maxUnits = 13, maximumLines = 500) {
  const output: string[] = [];

  for (const explicitLine of text.split(/\r?\n/)) {
    let line = "";
    let units = 0;

    for (const character of explicitLine) {
      const weight = characterWeight(character);
      if (line && units + weight > maxUnits) {
        output.push(line.trimEnd());
        line = character.trimStart();
        units = line ? weight : 0;
      } else {
        line += character;
        units += weight;
      }
    }

    output.push(line || " ");
    if (output.length >= maximumLines) break;
  }

  return output.slice(0, maximumLines);
}

export function wrappedTextLines(
  layer: Pick<TextLayer, "text" | "width" | "fontSize">,
) {
  const width = Math.round(clampNumber(layer.width, 0.12, 0.96) * OUTPUT_SIZE.width);
  const fontSize = Math.round(clampNumber(layer.fontSize, 18, 180));
  return wrapTitle(
    layer.text.trim().slice(0, 500) || " ",
    Math.max(2, Math.floor(width / fontSize)),
  );
}

export function createFrameSvg() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_SIZE.width}" height="${OUTPUT_SIZE.height}" viewBox="0 0 ${OUTPUT_SIZE.width} ${OUTPUT_SIZE.height}">
  <rect width="1080" height="159" fill="#ffffff"/>
  <rect y="1231" width="1080" height="119" fill="#fffdf9"/>
  <rect y="157" width="1080" height="2" fill="#e9e2d9"/>
  <path d="M 0 1276 H 1035 V 236 H 914" fill="none" stroke="#ff5423" stroke-width="7" stroke-linejoin="miter"/>
</svg>`.trim();
}

function textMarkup(layer: TextLayer) {
  const x = Math.round(clampNumber(layer.x, 0, 0.98) * OUTPUT_SIZE.width);
  const y = Math.round(clampNumber(layer.y, 0, 0.96) * OUTPUT_SIZE.height);
  const width = Math.round(clampNumber(layer.width, 0.12, 0.96) * OUTPUT_SIZE.width);
  const fontSize = Math.round(clampNumber(layer.fontSize, 18, 180));
  const lineHeight = Math.round(fontSize * 1.08);
  const lines = wrappedTextLines(layer);
  const textX = layer.textAlign === "center"
    ? x + Math.round(width / 2)
    : layer.textAlign === "right"
      ? x + width
      : x;
  const anchor = layer.textAlign === "center" ? "middle" : layer.textAlign === "right" ? "end" : "start";
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${textX}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  return {
    anchor,
    fontFamily: FONT_FAMILIES[layer.fontFamily] ?? FONT_FAMILIES.sans,
    fontSize,
    text: tspans,
    x: textX,
    y,
  };
}

export function createTextLayerSvg(layer: TextLayer) {
  const markup = textMarkup(layer);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_SIZE.width}" height="${OUTPUT_SIZE.height}" viewBox="0 0 ${OUTPUT_SIZE.width} ${OUTPUT_SIZE.height}">
  <defs>
    <filter id="text-shadow" x="-20%" y="-20%" width="160%" height="180%">
      <feDropShadow dx="0" dy="5" stdDeviation="3" flood-color="#1b130f" flood-opacity="0.32"/>
    </filter>
  </defs>
  <text x="${markup.x}" y="${markup.y}" dominant-baseline="hanging" text-anchor="${markup.anchor}" fill="${layer.color}" stroke="${layer.strokeColor}" stroke-width="${Math.round(layer.strokeWidth)}" stroke-linejoin="round" paint-order="stroke fill" font-family="${escapeXml(markup.fontFamily)}" font-size="${markup.fontSize}" font-weight="${layer.fontWeight}" filter="url(#text-shadow)">${markup.text}</text>
</svg>`.trim();
}

/** Legacy helper kept for compatibility with the original title-only renderer/tests. */
export function createOverlaySvg(title: TitlePlacement) {
  const layer = textLayerFromLegacyTitle({
    text: title.text.trim().slice(0, 180),
    x: clampNumber(title.x, 0.02, 0.92),
    y: clampNumber(title.y, 0.13, 0.84),
    fontSize: clampNumber(title.fontSize, 48, 132),
  });
  const textSvg = createTextLayerSvg(layer)
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "");
  return createFrameSvg().replace("</svg>", `${textSvg}</svg>`);
}
