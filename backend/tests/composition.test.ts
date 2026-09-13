import { describe, expect, it } from "vitest";

import {
  createTextLayerSvg,
  defaultCompositionLayers,
  MAX_COMPOSITION_JSON_BYTES,
  validateCompositionDocument,
  validateCompositionLayers,
  wrapTitle,
  type CompositionLayer,
  type TextLayer,
} from "../src/composition.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const UPLOAD_ID = "33333333-3333-4333-8333-333333333333";

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    id: "text-1",
    type: "text",
    name: "Text 1",
    text: "Layered story",
    x: 0.1,
    y: 0.2,
    width: 0.8,
    fontSize: 64,
    fontFamily: "sans",
    fontWeight: 700,
    color: "#ffffff",
    strokeColor: "#191816",
    strokeWidth: 4,
    textAlign: "left",
    ...overrides,
  };
}

describe("composition layer contract", () => {
  it("validates JSON documents and preserves bottom-to-top order", () => {
    const layers: CompositionLayer[] = [
      ...defaultCompositionLayers(),
      {
        id: "image-1",
        type: "image",
        role: "overlay",
        name: "Portrait",
        src: `/media/${PROJECT_ID}/images/overlay-${UPLOAD_ID}.png`,
        x: 0.2,
        y: 0.3,
        width: 0.25,
        aspectRatio: 1,
        mask: "circle",
      },
    ];

    const parsed = validateCompositionDocument(
      JSON.stringify({ version: 1, layers }),
      { projectId: PROJECT_ID },
    );

    expect(parsed.layers.map(({ id }) => id)).toEqual(["brand-logo", "text-1", "image-1"]);
  });

  it("preserves wide image frames instead of forcing them to 5:1", () => {
    const layers: CompositionLayer[] = [
      ...defaultCompositionLayers(),
      {
        id: "image-wordmark",
        type: "image",
        role: "overlay",
        name: "Wordmark",
        src: `/media/${PROJECT_ID}/images/overlay-${UPLOAD_ID}.png`,
        x: 0.1,
        y: 0.3,
        width: 0.8,
        aspectRatio: 12,
        mask: "none",
      },
    ];

    expect(validateCompositionLayers(layers, { projectId: PROJECT_ID }).at(-1))
      .toMatchObject({ aspectRatio: 12, width: 0.8 });
  });

  it("rejects unsafe styles, duplicate IDs, excess layers, and cross-project image sources", () => {
    const defaults = defaultCompositionLayers();
    expect(() => validateCompositionLayers([
      defaults[0],
      textLayer({ color: "url(javascript:alert(1))" }),
    ])).toThrow(/font color/);
    expect(() => validateCompositionLayers([defaults[0], defaults[0]])).toThrow(/unique/);
    expect(() => validateCompositionLayers(
      Array.from({ length: 21 }, (_, index) => textLayer({ id: `text-${index}` })),
    )).toThrow(/at most 20/);
    expect(() => validateCompositionLayers([
      {
        ...defaults[0]!,
        src: `/media/${OTHER_PROJECT_ID}/images/overlay-${UPLOAD_ID}.png`,
      },
    ], { projectId: PROJECT_ID })).toThrow(/project-owned/);
  });

  it("renders escaped text with the selected typography and alignment", () => {
    const svg = createTextLayerSvg(textLayer({
      text: "A & B <story>",
      color: "#123456",
      strokeColor: "#abcdef",
      strokeWidth: 8,
      fontFamily: "serif",
      fontWeight: 900,
      textAlign: "right",
    }));

    expect(svg).toContain("A &amp; B &lt;story&gt;");
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('stroke="#abcdef"');
    expect(svg).toContain('stroke-width="8"');
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toContain('font-weight="900"');
    expect(svg).not.toContain("A & B <story>");
  });

  it("caps wrapped text at twelve lines", () => {
    expect(wrapTitle(Array.from({ length: 20 }, (_, index) => `${index}`).join("\n"), 13, 12))
      .toHaveLength(12);
  });

  it("rejects composition fields above the explicit parsed JSON limit", () => {
    expect(() => validateCompositionDocument(" ".repeat(MAX_COMPOSITION_JSON_BYTES + 1)))
      .toThrow(/too large/);
  });
});
