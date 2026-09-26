import { describe, expect, it } from "vitest";

import {
  getSquareCropGeometry,
  MAX_CROP_ZOOM,
} from "../lib/image-crop";

describe("square crop geometry", () => {
  it("centers a square crop in a landscape source", () => {
    expect(getSquareCropGeometry({
      sourceWidth: 1_200,
      sourceHeight: 800,
    })).toEqual({
      source: { x: 200, y: 0, size: 800 },
      preview: {
        widthPercent: 150,
        heightPercent: 100,
        leftPercent: -25,
        topPercent: 0,
      },
    });
  });

  it("centers a square crop in a portrait source", () => {
    expect(getSquareCropGeometry({
      sourceWidth: 800,
      sourceHeight: 1_200,
    })).toEqual({
      source: { x: 0, y: 200, size: 800 },
      preview: {
        widthPercent: 100,
        heightPercent: 150,
        leftPercent: 0,
        topPercent: -25,
      },
    });
  });

  it("maps normalized positions linearly across the zoomed crop range", () => {
    expect(getSquareCropGeometry({
      sourceWidth: 1_200,
      sourceHeight: 800,
      zoom: 2,
      positionX: 0.75,
      positionY: 0.25,
    })).toEqual({
      source: { x: 600, y: 100, size: 400 },
      preview: {
        widthPercent: 300,
        heightPercent: 200,
        leftPercent: -150,
        topPercent: -25,
      },
    });
  });

  it("clamps zoom and crop positions to their supported bounds", () => {
    const crop = getSquareCropGeometry({
      sourceWidth: 900,
      sourceHeight: 600,
      zoom: 99,
      positionX: -4,
      positionY: 8,
    });

    expect(crop.source).toEqual({
      x: 0,
      y: 400,
      size: 600 / MAX_CROP_ZOOM,
    });
    expect(crop.source.x + crop.source.size).toBeLessThanOrEqual(900);
    expect(crop.source.y + crop.source.size).toBeLessThanOrEqual(600);

    expect(getSquareCropGeometry({
      sourceWidth: 900,
      sourceHeight: 600,
      zoom: -10,
      positionX: 1,
      positionY: 1,
    }).source).toEqual({ x: 300, y: 0, size: 600 });
  });

  it("normalizes invalid inputs to finite, drawable geometry", () => {
    const crop = getSquareCropGeometry({
      sourceWidth: Number.NaN,
      sourceHeight: -400,
      zoom: Number.POSITIVE_INFINITY,
      positionX: Number.NaN,
      positionY: Number.NEGATIVE_INFINITY,
    });

    expect(crop).toEqual({
      source: { x: 0, y: 0, size: 1 },
      preview: {
        widthPercent: 100,
        heightPercent: 100,
        leftPercent: 0,
        topPercent: 0,
      },
    });
  });
});
