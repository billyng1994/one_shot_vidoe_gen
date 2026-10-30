export const OUTPUT_SIZE = { width: 1080, height: 1350 } as const;
export const MEDIA_RECT = { x: 0, y: 159, width: 1080, height: 1072 } as const;
export const BRAND_LOGO_RECT = { x: 400, y: 28, width: 288, height: 118 } as const;
export const DEFAULT_LOGO_SRC = "/gostudy-logo.svg";
export const MAX_COMPOSITION_LAYERS = 20;
export const MIN_IMAGE_ASPECT_RATIO = 0.01;
export const MAX_IMAGE_ASPECT_RATIO = 100;
export const MIN_IMAGE_LAYER_WIDTH = 0.01;
export const MIN_BACKGROUND_ASPECT_RATIO = 0.2;
export const MAX_BACKGROUND_ASPECT_RATIO = 3.2;
export const MAX_BACKGROUND_LAYER_WIDTH = 4;

export const FONT_FAMILIES = {
  sans: '"Liberation Sans", Arial, "Noto Sans CJK TC", "PingFang TC", sans-serif',
  display: '"Liberation Sans", Arial, "Noto Sans CJK TC", "PingFang TC", sans-serif',
  serif: '"Liberation Serif", "Times New Roman", "Noto Serif CJK TC", "Songti TC", serif',
  mono: '"Liberation Mono", "Courier New", "Noto Sans Mono CJK TC", monospace',
} as const;

export type FontFamily = keyof typeof FONT_FAMILIES;
export type FontWeight = 400 | 700 | 900;
export type TextAlignment = "left" | "center" | "right";
export type ImageMask = "none" | "circle";

export type TitlePlacement = {
  text: string;
  x: number;
  y: number;
  fontSize: number;
};

export type TextLayer = {
  id: string;
  type: "text";
  name: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily: FontFamily;
  fontWeight: FontWeight;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  textAlign: TextAlignment;
};

export type ImageLayer = {
  id: string;
  type: "image";
  role: "background" | "logo" | "overlay";
  name: string;
  src: string;
  x: number;
  y: number;
  width: number;
  aspectRatio: number;
  mask: ImageMask;
};

export type CompositionLayer = TextLayer | ImageLayer;

export const DEFAULT_TITLE: TitlePlacement = {
  text: "Your story starts here",
  x: 0.055,
  y: 0.165,
  fontSize: 86,
};

export function createDefaultLogoLayer(): ImageLayer {
  return {
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
  };
}

export function backgroundCoverWidth(aspectRatio: number) {
  return Math.max(
    1,
    clampNumber(
      aspectRatio,
      MIN_BACKGROUND_ASPECT_RATIO,
      MAX_BACKGROUND_ASPECT_RATIO,
    )
      * OUTPUT_SIZE.height / OUTPUT_SIZE.width,
  );
}

export function createBackgroundLayer(
  src: string,
  aspectRatio: number,
  name = "Background photo",
): ImageLayer {
  const normalizedAspectRatio = clampNumber(
    aspectRatio,
    MIN_BACKGROUND_ASPECT_RATIO,
    MAX_BACKGROUND_ASPECT_RATIO,
  );
  const width = backgroundCoverWidth(normalizedAspectRatio);
  const layer: ImageLayer = {
    id: "background-photo",
    type: "image",
    role: "background",
    name,
    src,
    x: 0,
    y: 0,
    width,
    aspectRatio: normalizedAspectRatio,
    mask: "none",
  };
  const height = imageLayerHeight(layer);
  return {
    ...layer,
    x: (1 - width) / 2,
    y: (1 - height) / 2,
  };
}

export function textLayerFromTitle(title: TitlePlacement): TextLayer {
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

  return positionLayer(layer, title.x, title.y);
}

export function createDefaultLayers(title: TitlePlacement = DEFAULT_TITLE): CompositionLayer[] {
  return [createDefaultLogoLayer(), textLayerFromTitle(title)];
}

export function createTextLayer(id: string, index: number): TextLayer {
  return {
    id,
    type: "text",
    name: `Text ${index}`,
    text: "Add your text",
    x: 0.1,
    y: 0.24,
    width: 0.8,
    fontSize: 64,
    fontFamily: "sans",
    fontWeight: 700,
    color: "#ffffff",
    strokeColor: "#191816",
    strokeWidth: 4,
    textAlign: "left",
  };
}

export function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function imageLayerHeight(layer: ImageLayer) {
  const squareHeight = layer.width * OUTPUT_SIZE.width / OUTPUT_SIZE.height;
  return layer.mask === "circle"
    ? squareHeight
    : squareHeight / clampNumber(
        layer.aspectRatio,
        MIN_IMAGE_ASPECT_RATIO,
        MAX_IMAGE_ASPECT_RATIO,
      );
}

type ImageLayerGeometry = Pick<ImageLayer, "aspectRatio" | "mask"> &
  Partial<Pick<ImageLayer, "role">>;

export function minimumImageLayerWidth(layer: ImageLayerGeometry) {
  return layer.role === "background"
    ? backgroundCoverWidth(layer.aspectRatio)
    : MIN_IMAGE_LAYER_WIDTH;
}

export function maximumImageLayerWidth(layer: ImageLayerGeometry) {
  if (layer.role === "background") {
    const aspectRatio = clampNumber(
      layer.aspectRatio,
      MIN_BACKGROUND_ASPECT_RATIO,
      MAX_BACKGROUND_ASPECT_RATIO,
    );
    return Math.min(
      backgroundCoverWidth(aspectRatio) * 3,
      MAX_BACKGROUND_LAYER_WIDTH,
      5 * aspectRatio,
    );
  }
  return layer.mask === "circle"
    ? 0.95
    : Math.min(0.95, 0.95 * layer.aspectRatio * OUTPUT_SIZE.height / OUTPUT_SIZE.width);
}

export function imageLayerPositionBounds(layer: ImageLayer) {
  const height = imageLayerHeight(layer);
  if (layer.role === "background") {
    return {
      minimumX: Math.min(0, 1 - layer.width),
      maximumX: 0,
      minimumY: Math.min(0, 1 - height),
      maximumY: 0,
    };
  }
  return {
    minimumX: 0,
    maximumX: Math.max(0, 1 - layer.width),
    minimumY: 0,
    maximumY: Math.max(0, 1 - height),
  };
}

export function textLayerHeight(layer: TextLayer) {
  const fontSize = Math.round(clampNumber(layer.fontSize, 18, 180));
  const lineHeight = Math.round(fontSize * 1.08);
  const lineCount = wrappedTextLines(layer).length;
  return Math.min(0.96, (lineCount * lineHeight) / OUTPUT_SIZE.height);
}

export function layerHeight(layer: CompositionLayer) {
  return layer.type === "image" ? imageLayerHeight(layer) : textLayerHeight(layer);
}

export function positionLayer<T extends CompositionLayer>(layer: T, x: number, y: number): T {
  if (layer.type === "image") {
    const bounds = imageLayerPositionBounds(layer);
    return {
      ...layer,
      x: clampNumber(x, bounds.minimumX, bounds.maximumX),
      y: clampNumber(y, bounds.minimumY, bounds.maximumY),
    };
  }
  return {
    ...layer,
    x: clampNumber(x, 0, Math.max(0, 1 - layer.width)),
    y: clampNumber(y, 0, Math.max(0, 1 - layerHeight(layer))),
  };
}

export function reorderLayersForVisualDrop(
  layers: readonly CompositionLayer[],
  sourceId: string,
  targetId: string,
) {
  if (sourceId === targetId) return [...layers];
  const background = layers.find(
    (layer) => layer.type === "image" && layer.role === "background",
  );
  if (sourceId === background?.id || targetId === background?.id) return [...layers];
  const movableLayers = background
    ? layers.filter((layer) => layer !== background)
    : [...layers];
  const visualLayers = [...movableLayers].reverse();
  const sourceIndex = visualLayers.findIndex(({ id }) => id === sourceId);
  const targetIndex = visualLayers.findIndex(({ id }) => id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return [...layers];
  const [moved] = visualLayers.splice(sourceIndex, 1);
  if (!moved) return [...layers];
  visualLayers.splice(targetIndex, 0, moved);
  const reordered = visualLayers.reverse();
  return background ? [background, ...reordered] : reordered;
}

export function moveLayerOneStep(
  layers: readonly CompositionLayer[],
  layerId: string,
  direction: "forward" | "backward",
) {
  const background = layers.find(
    (layer) => layer.type === "image" && layer.role === "background",
  );
  if (layerId === background?.id) return [...layers];
  const movableLayers = background
    ? layers.filter((layer) => layer !== background)
    : [...layers];
  const currentIndex = movableLayers.findIndex(({ id }) => id === layerId);
  const targetIndex = currentIndex + (direction === "forward" ? 1 : -1);
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= movableLayers.length) {
    return [...layers];
  }
  const next = [...movableLayers];
  [next[currentIndex], next[targetIndex]] = [next[targetIndex]!, next[currentIndex]!];
  return background ? [background, ...next] : next;
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

export function createTextLayerSvg(layer: TextLayer) {
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
  const anchor = layer.textAlign === "center"
    ? "middle"
    : layer.textAlign === "right"
      ? "end"
      : "start";
  const family = FONT_FAMILIES[layer.fontFamily] ?? FONT_FAMILIES.sans;
  const textLines = lines
    .map(
      (line, index) =>
        `<tspan x="${textX}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_SIZE.width}" height="${OUTPUT_SIZE.height}" viewBox="0 0 ${OUTPUT_SIZE.width} ${OUTPUT_SIZE.height}">
  <defs>
    <filter id="text-shadow" x="-20%" y="-20%" width="160%" height="180%">
      <feDropShadow dx="0" dy="5" stdDeviation="3" flood-color="#1b130f" flood-opacity="0.32"/>
    </filter>
  </defs>
  <text x="${textX}" y="${y}" dominant-baseline="hanging" text-anchor="${anchor}" fill="${isHexColor(layer.color) ? layer.color : "#ffffff"}" stroke="${isHexColor(layer.strokeColor) ? layer.strokeColor : "#191816"}" stroke-width="${Math.round(clampNumber(layer.strokeWidth, 0, 20))}" stroke-linejoin="round" paint-order="stroke fill" font-family="${escapeXml(family)}" font-size="${fontSize}" font-weight="${layer.fontWeight}" filter="url(#text-shadow)">${textLines}</text>
</svg>`.trim();
}

/** Backwards-compatible single-title overlay helper used by older callers. */
export function createOverlaySvg(title: TitlePlacement) {
  const layer = textLayerFromTitle({
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
