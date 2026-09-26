export const MIN_CROP_ZOOM = 1;
export const MAX_CROP_ZOOM = 3;

export type SquareCropInput = {
  sourceWidth: number;
  sourceHeight: number;
  zoom?: number;
  positionX?: number;
  positionY?: number;
};

export type SquareCropGeometry = {
  source: {
    x: number;
    y: number;
    size: number;
  };
  preview: {
    widthPercent: number;
    heightPercent: number;
    leftPercent: number;
    topPercent: number;
  };
};

function clampFinite(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveDimension(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Converts zoom and normalized crop positions into a bounded square source rectangle.
 * A position of 0, 0.5, or 1 aligns the crop to the start, center, or end
 * of the source image along that axis.
 * Preview percentages position the full source image inside a square,
 * overflow-hidden preview using the exact same crop.
 */
export function getSquareCropGeometry({
  sourceWidth,
  sourceHeight,
  zoom,
  positionX,
  positionY,
}: SquareCropInput): SquareCropGeometry {
  const width = positiveDimension(sourceWidth);
  const height = positiveDimension(sourceHeight);
  const safeZoom = clampFinite(zoom, MIN_CROP_ZOOM, MAX_CROP_ZOOM, MIN_CROP_ZOOM);
  const safePositionX = clampFinite(positionX, 0, 1, 0.5);
  const safePositionY = clampFinite(positionY, 0, 1, 0.5);
  const size = Math.min(width, height) / safeZoom;
  const maximumX = width - size;
  const maximumY = height - size;
  const x = maximumX * safePositionX;
  const y = maximumY * safePositionY;

  return {
    source: { x, y, size },
    preview: {
      widthPercent: width / size * 100,
      heightPercent: height / size * 100,
      leftPercent: x === 0 ? 0 : -x / size * 100,
      topPercent: y === 0 ? 0 : -y / size * 100,
    },
  };
}
