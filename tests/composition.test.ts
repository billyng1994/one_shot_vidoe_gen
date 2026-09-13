import { describe, expect, it } from "vitest";

import {
  BRAND_LOGO_RECT,
  clampNumber,
  createDefaultLogoLayer,
  createOverlaySvg,
  createTextLayer,
  createTextLayerSvg,
  escapeXml,
  imageLayerHeight,
  OUTPUT_SIZE,
  positionLayer,
  reorderLayersForVisualDrop,
  wrapTitle,
} from "../lib/composition";

describe("composition helpers", () => {
  it("clamps finite and invalid numeric input", () => {
    expect(clampNumber(0.5, 0, 1)).toBe(0.5);
    expect(clampNumber(2, 0, 1)).toBe(1);
    expect(clampNumber(Number.NaN, 2, 4)).toBe(2);
  });

  it("escapes title content before embedding it in SVG", () => {
    expect(escapeXml(`<script data-name="a&b">'x'</script>`)).toBe(
      "&lt;script data-name=&quot;a&amp;b&quot;&gt;&apos;x&apos;&lt;/script&gt;",
    );
  });

  it("keeps explicit title line breaks and honors a configured line cap", () => {
    expect(wrapTitle("第一行\n第二行\n第三行\n第四行\n第五行", 20, 4)).toEqual([
      "第一行",
      "第二行",
      "第三行",
      "第四行",
    ]);
  });

  it("does not silently discard valid multi-line text", () => {
    expect(wrapTitle(Array.from({ length: 20 }, (_, index) => `Line ${index}`).join("\n"), 20))
      .toHaveLength(20);
  });

  it("uses square geometry for circular image layers and clamps their position", () => {
    const circle = {
      ...createDefaultLogoLayer(),
      mask: "circle" as const,
      width: 0.3,
      aspectRatio: 3,
    };

    expect(imageLayerHeight(circle)).toBeCloseTo(0.24);
    expect(positionLayer(circle, 2, 2)).toMatchObject({ x: 0.7, y: 0.76 });
  });

  it("preserves unusually wide image frames instead of forcing them to 5:1", () => {
    const wordmark = {
      ...createDefaultLogoLayer(),
      width: 0.8,
      aspectRatio: 12,
    };

    expect(imageLayerHeight(wordmark)).toBeCloseTo(0.8 * 1080 / 1350 / 12);
  });

  it("reorders layers to both extremes using the front-first visual stack", () => {
    const layers = [
      createDefaultLogoLayer(),
      createTextLayer("middle", 2),
      createTextLayer("front", 3),
    ];

    expect(reorderLayersForVisualDrop(layers, "front", "brand-logo").map(({ id }) => id))
      .toEqual(["front", "brand-logo", "middle"]);
    expect(reorderLayersForVisualDrop(layers, "brand-logo", "front").map(({ id }) => id))
      .toEqual(["middle", "front", "brand-logo"]);
  });

  it("escapes arbitrary text when creating a styled text layer SVG", () => {
    const svg = createTextLayerSvg({
      ...createTextLayer("text-safe", 2),
      text: `<script data-name="a&b">'hello'</script>`,
      color: "#12abef",
      strokeColor: "#fedcba",
      textAlign: "center",
    });

    expect(svg).toContain("&lt;script data-name=&quot;a&amp;b&quot;");
    expect(svg).toContain("&gt;&apos;hello&apos;&lt;/script&gt;");
    expect(svg).toContain('fill="#12abef"');
    expect(svg).toContain('stroke="#fedcba"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).not.toContain("<script");
  });

  it("creates a safely escaped overlay without recreating the brand as text", () => {
    const svg = createOverlaySvg({
      text: "A & B <story>",
      x: -4,
      y: 9,
      fontSize: 999,
    });

    expect(svg).not.toContain("GOSTUDY.HK");
    expect(svg).toContain("A &amp; B &lt;story");
    expect(svg).toContain("&gt;");
    expect(svg).toContain('font-size="132"');
    expect(svg).not.toContain("A & B <story>");
  });

  it("keeps the supplied brand logo inside the top header", () => {
    expect(BRAND_LOGO_RECT.x).toBeGreaterThanOrEqual(0);
    expect(BRAND_LOGO_RECT.y).toBeGreaterThanOrEqual(0);
    expect(BRAND_LOGO_RECT.x + BRAND_LOGO_RECT.width).toBeLessThanOrEqual(
      OUTPUT_SIZE.width,
    );
    expect(BRAND_LOGO_RECT.y + BRAND_LOGO_RECT.height).toBeLessThanOrEqual(159);
  });
});
