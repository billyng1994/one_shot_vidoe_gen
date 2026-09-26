import { MAX_COMPOSITION_LAYERS } from "./composition";

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

const TEMPLATE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEMPLATE_NAME_LENGTH = 80;
const MAX_TEMPLATES_PER_ACCOUNT = 50;

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
