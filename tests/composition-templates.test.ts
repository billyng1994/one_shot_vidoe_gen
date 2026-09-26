import { describe, expect, it } from "vitest";

import {
  parseCompositionTemplateList,
  parseCompositionTemplateSummary,
  type CompositionTemplateSummary,
} from "../lib/composition-templates";

const TEMPLATE_ID = "12345678-1234-4234-8234-123456789012";

function summary(
  overrides: Partial<CompositionTemplateSummary> = {},
): CompositionTemplateSummary {
  return {
    version: 1,
    id: TEMPLATE_ID,
    name: "Launch frame",
    framePreset: "onetake-v1",
    createdAt: "2026-09-26T08:00:00.000Z",
    updatedAt: "2026-09-26T09:00:00.000Z",
    layerCount: 4,
    textLayerCount: 2,
    imageLayerCount: 2,
    ...overrides,
  };
}

describe("composition template summaries", () => {
  it("parses a valid public summary without retaining unknown fields", () => {
    expect(parseCompositionTemplateSummary({ ...summary(), privatePath: "/secret" }))
      .toEqual(summary());
  });

  it.each([
    null,
    [],
    { ...summary(), version: 2 },
    { ...summary(), id: "legacy-v1" },
    { ...summary(), name: "  Launch frame  " },
    { ...summary(), name: "" },
    { ...summary(), name: "x".repeat(81) },
    { ...summary(), framePreset: "other-frame" },
    { ...summary(), createdAt: "not-a-date" },
    { ...summary(), updatedAt: 123 },
    { ...summary(), layerCount: 0, textLayerCount: 0, imageLayerCount: 0 },
    { ...summary(), layerCount: 21, textLayerCount: 20, imageLayerCount: 1 },
    { ...summary(), layerCount: 2.5, textLayerCount: 1.5, imageLayerCount: 1 },
    { ...summary(), layerCount: 4, textLayerCount: 2, imageLayerCount: 1 },
    { ...summary(), layerCount: 2, textLayerCount: 2, imageLayerCount: 0 },
  ])("rejects an invalid summary %#", (value) => {
    expect(parseCompositionTemplateSummary(value)).toBeNull();
  });

  it("parses a full list response and preserves server order", () => {
    const second = summary({
      id: "87654321-4321-4321-8321-210987654321",
      name: "Older frame",
    });

    expect(parseCompositionTemplateList({ templates: [summary(), second] })).toEqual([
      summary(),
      second,
    ]);
    expect(parseCompositionTemplateList({ templates: [] })).toEqual([]);
  });

  it("rejects malformed list responses, invalid entries, and duplicate IDs", () => {
    expect(parseCompositionTemplateList(null)).toBeNull();
    expect(parseCompositionTemplateList({})).toBeNull();
    expect(parseCompositionTemplateList({ templates: "invalid" })).toBeNull();
    expect(parseCompositionTemplateList({
      templates: [summary(), { ...summary(), name: "Invalid", layerCount: -1 }],
    })).toBeNull();
    expect(parseCompositionTemplateList({
      templates: [summary(), summary({ id: TEMPLATE_ID.toUpperCase() })],
    })).toBeNull();
  });

  it("rejects lists above the backend account limit", () => {
    const templates = Array.from({ length: 51 }, (_, index) => summary({
      id: `12345678-1234-4234-8234-${String(index).padStart(12, "0")}`,
    }));

    expect(parseCompositionTemplateList({ templates })).toBeNull();
  });
});
