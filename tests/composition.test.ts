import { describe, expect, it } from "vitest";

import {
  BRAND_LOGO_RECT,
  clampNumber,
  createOverlaySvg,
  escapeXml,
  OUTPUT_SIZE,
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

  it("keeps explicit title line breaks and caps the output at four lines", () => {
    expect(wrapTitle("第一行\n第二行\n第三行\n第四行\n第五行", 20)).toEqual([
      "第一行",
      "第二行",
      "第三行",
      "第四行",
    ]);
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
