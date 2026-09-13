import { describe, expect, it } from "vitest";

import {
  parseStudioSnapshot,
  serializeStudioSnapshot,
  type StudioSnapshot,
} from "../lib/studio-state";
import { DEFAULT_LOGO_SRC } from "../lib/composition";

const IMAGE_ID = "cli-image-12345678-1234-4234-8234-123456789012";
const VIDEO_ID = "cli-video-87654321-4321-4321-8321-210987654321";
const BACKEND_IMAGE_ID = "gen-image-12345678-1234-4234-8234-123456789012";
const PROJECT_ID = "12345678-1234-4234-8234-123456789012";

describe("studio state persistence", () => {
  it("round-trips generated assets and editor settings", () => {
    const snapshot: StudioSnapshot = {
      version: 2,
      step: 3,
      imagePrompt: "Editorial portrait",
      motionPrompt: "Slow push in",
      image: { requestId: IMAGE_ID, url: "https://cdn.example/image.png" },
      video: { requestId: VIDEO_ID, url: "https://cdn.example/video.mp4" },
      duration: 8,
      resolution: "1080",
      cameraFixed: true,
      layers: [
        {
          id: "brand-logo",
          type: "image",
          role: "logo",
          name: "Brand logo",
          src: DEFAULT_LOGO_SRC,
          x: 0.35,
          y: 0.02,
          width: 0.3,
          aspectRatio: 2.4,
          mask: "none",
        },
        {
          id: "text-1",
          type: "text",
          name: "Headline",
          text: "Saved title",
          x: 0.12,
          y: 0.3,
          width: 0.7,
          fontSize: 72,
          fontFamily: "display",
          fontWeight: 900,
          color: "#ff5423",
          strokeColor: "#fffdf9",
          strokeWidth: 10,
          textAlign: "center",
        },
        {
          id: "image-badge",
          type: "image",
          role: "overlay",
          name: "Badge",
          src: `/media/${PROJECT_ID}/images/overlay-11111111-2222-4333-8444-555555555555.png`,
          x: 0.58,
          y: 0.52,
          width: 0.24,
          aspectRatio: 1,
          mask: "circle",
        },
      ],
      musicVolume: 0.35,
    };

    expect(parseStudioSnapshot(serializeStudioSnapshot(snapshot))).toEqual(snapshot);
  });

  it("migrates a version 1 title into default logo and text layers", () => {
    const restored = parseStudioSnapshot(
      JSON.stringify({
        version: 1,
        step: 3,
        image: { requestId: IMAGE_ID, url: "https://cdn.example/image.png" },
        video: { requestId: VIDEO_ID, url: "https://cdn.example/video.mp4" },
        title: { text: "Legacy title", x: 0.2, y: 0.3, fontSize: 72 },
      }),
    );

    expect(restored).toMatchObject({
      version: 2,
      layers: [
        { id: "brand-logo", type: "image", role: "logo", src: DEFAULT_LOGO_SRC },
        {
          id: "text-1",
          type: "text",
          text: "Legacy title",
          x: 0.12,
          y: 0.3,
          fontSize: 72,
        },
      ],
    });
  });

  it("rejects unsafe asset values and returns to the first incomplete step", () => {
    const restored = parseStudioSnapshot(
      JSON.stringify({
        version: 2,
        step: 3,
        image: { requestId: "../../credentials.json", url: "javascript:alert(1)" },
        video: { requestId: VIDEO_ID, url: "//evil.example/video.mp4" },
        layers: [
          {
            id: "../unsafe-id",
            type: "text",
            name: "  Unsafe    text  ",
            text: "Title",
            x: -20,
            y: 20,
            width: 0.8,
            fontSize: 900,
            fontFamily: "comic-sans",
            fontWeight: 500,
            color: "red",
            strokeColor: "javascript:alert(1)",
            strokeWidth: 900,
            textAlign: "sideways",
          },
          {
            id: "unsafe-image",
            type: "image",
            role: "overlay",
            name: "Unsafe image",
            src: "https://evil.example/image.png",
            x: 0.2,
            y: 0.2,
            width: 0.2,
            aspectRatio: 1,
            mask: "circle",
          },
        ],
      }),
    );

    expect(restored).toMatchObject({
      version: 2,
      step: 1,
      image: { requestId: "", url: "" },
      video: { requestId: VIDEO_ID, url: "" },
      layers: [
        { id: "brand-logo", type: "image", src: DEFAULT_LOGO_SRC },
        {
          id: "text-1",
          type: "text",
          name: "Unsafe text",
          x: 0,
          fontSize: 180,
          fontFamily: "sans",
          fontWeight: 700,
          color: "#ffffff",
          strokeColor: "#191816",
          strokeWidth: 20,
          textAlign: "left",
        },
      ],
    });
    expect(restored?.layers).toHaveLength(2);
    expect(restored?.layers[1]?.y).toBeCloseTo(1 - 194 / 1350);
  });

  it("accepts opaque generation IDs issued by the backend", () => {
    const restored = parseStudioSnapshot(
      JSON.stringify({
        version: 2,
        step: 2,
        image: { requestId: BACKEND_IMAGE_ID, url: "/media/projects/demo/image.png" },
      }),
    );

    expect(restored?.image).toEqual({
      requestId: BACKEND_IMAGE_ID,
      url: "/media/projects/demo/image.png",
    });
  });

  it("reserves the default logo ID and rejects inherited font-family keys", () => {
    const restored = parseStudioSnapshot(JSON.stringify({
      version: 2,
      step: 1,
      layers: [{
        id: "brand-logo",
        type: "text",
        name: "Text",
        text: "Safe fallback",
        x: 0.1,
        y: 0.2,
        width: 0.8,
        fontSize: 64,
        fontFamily: "constructor",
        fontWeight: 700,
        color: "#ffffff",
        strokeColor: "#000000",
        strokeWidth: 4,
        textAlign: "left",
      }],
    }));

    expect(restored?.layers.map(({ id }) => id)).toEqual(["brand-logo", "text-1"]);
    expect(restored?.layers[1]).toMatchObject({ type: "text", fontFamily: "sans" });
  });

  it("keeps the required logo within the twenty-layer limit", () => {
    const layers = Array.from({ length: 20 }, (_, index) => ({
      id: `text-${index + 1}`,
      type: "text",
      name: `Text ${index + 1}`,
      text: "Layer",
      x: 0.1,
      y: 0.2,
      width: 0.8,
      fontSize: 64,
      fontFamily: "sans",
      fontWeight: 700,
      color: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 4,
      textAlign: "left",
    }));
    const restored = parseStudioSnapshot(JSON.stringify({ version: 2, step: 1, layers }));

    expect(restored?.layers).toHaveLength(20);
    expect(restored?.layers[0]).toMatchObject({ id: "brand-logo", role: "logo" });
  });

  it("ignores corrupt or unknown snapshot versions", () => {
    expect(parseStudioSnapshot("not-json")).toBeNull();
    expect(parseStudioSnapshot(JSON.stringify({ version: 3 }))).toBeNull();
  });
});
