import { describe, expect, it } from "vitest";

import {
  parseCompositionTemplateAssetUpload,
  parseCompositionTemplateDetail,
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
  it("accepts only template-owned asset upload responses", () => {
    const assetId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const response = {
      assetId,
      url: `/api/composition-templates/${TEMPLATE_ID}/assets/${assetId}`,
      width: 1200,
      height: 800,
      privatePath: "/secret/image.png",
    };

    expect(parseCompositionTemplateAssetUpload(response, TEMPLATE_ID)).toEqual({
      assetId,
      url: response.url,
      width: 1200,
      height: 800,
    });
    expect(parseCompositionTemplateAssetUpload({
      ...response,
      url: `${response.url}?download=1`,
    }, TEMPLATE_ID)).toBeNull();
    expect(parseCompositionTemplateAssetUpload(response, "87654321-4321-4321-8321-210987654321"))
      .toBeNull();
  });

  it("parses an editable detail with a template-owned background and strips unknown fields", () => {
    const assetId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const detail = {
      ...summary({ layerCount: 3, textLayerCount: 1, imageLayerCount: 2 }),
      privatePath: "/secret",
      layers: [
        {
          id: "background",
          type: "image",
          role: "background",
          name: "Background",
          src: `/api/composition-templates/${TEMPLATE_ID}/assets/${assetId}`,
          x: 0,
          y: 0,
          width: 1,
          aspectRatio: 0.8,
          mask: "none",
          privatePath: "/secret/image.png",
        },
        {
          id: "brand-logo",
          type: "image",
          role: "logo",
          name: "Brand logo",
          src: "/gostudy-logo.svg",
          x: 0.36,
          y: 0.02,
          width: 0.27,
          aspectRatio: 2.44,
          mask: "none",
        },
        {
          id: "headline",
          type: "text",
          name: "Headline",
          text: "Study abroad",
          x: 0.1,
          y: 0.2,
          width: 0.8,
          fontSize: 72,
          fontFamily: "display",
          fontWeight: 900,
          color: "#ff5423",
          strokeColor: "#fffdf9",
          strokeWidth: 8,
          textAlign: "center",
        },
      ],
    };

    expect(parseCompositionTemplateDetail(detail)).toEqual({
      ...summary({ layerCount: 3, textLayerCount: 1, imageLayerCount: 2 }),
      layers: detail.layers.map(({ privatePath, ...layer }) => (void privatePath, layer)),
    });
  });

  it("rejects details with unsafe assets, inconsistent counts, or invalid layer invariants", () => {
    const assetId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const base = {
      ...summary({ layerCount: 2, textLayerCount: 1, imageLayerCount: 1 }),
      layers: [
        {
          id: "brand-logo",
          type: "image",
          role: "logo",
          name: "Brand logo",
          src: "/gostudy-logo.svg",
          x: 0.36,
          y: 0.02,
          width: 0.27,
          aspectRatio: 2.44,
          mask: "none",
        },
        {
          id: "headline",
          type: "text",
          name: "Headline",
          text: "Study abroad",
          x: 0.1,
          y: 0.2,
          width: 0.8,
          fontSize: 72,
          fontFamily: "display",
          fontWeight: 900,
          color: "#ff5423",
          strokeColor: "#fffdf9",
          strokeWidth: 8,
          textAlign: "center",
        },
      ],
    };
    const templateAsset = `/api/composition-templates/${TEMPLATE_ID}/assets/${assetId}`;
    const background = {
      id: "background",
      type: "image",
      role: "background",
      name: "Background",
      src: templateAsset,
      x: 0,
      y: 0,
      width: 1,
      aspectRatio: 0.8,
      mask: "none",
    };
    const withBackground = {
      ...base,
      ...summary({ layerCount: 3, textLayerCount: 1, imageLayerCount: 2 }),
      layers: [background, ...base.layers],
    };

    const invalidDetails = [
      { ...base, layerCount: 3 },
      { ...base, layers: [base.layers[0], { ...base.layers[1], id: "brand-logo" }] },
      { ...base, layers: [{ ...base.layers[0], role: "overlay", src: templateAsset }, base.layers[1]] },
      { ...base, layers: [{ ...base.layers[0], role: "overlay" }, base.layers[1]] },
      { ...withBackground, layers: [base.layers[0], background, base.layers[1]] },
      { ...withBackground, layers: [{ ...background, mask: "circle" }, ...base.layers] },
      { ...withBackground, layers: [{ ...background, src: `${templateAsset}?download=1` }, ...base.layers] },
      { ...withBackground, layers: [{ ...background, width: 0.99 }, ...base.layers] },
      { ...withBackground, layers: [{ ...background, aspectRatio: 0.1 }, ...base.layers] },
      {
        ...withBackground,
        layerCount: 4,
        imageLayerCount: 3,
        layers: [background, { ...background, id: "background-two" }, ...base.layers],
      },
    ];

    for (const invalid of invalidDetails) {
      expect(parseCompositionTemplateDetail(invalid)).toBeNull();
    }
  });

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
