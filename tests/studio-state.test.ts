import { describe, expect, it } from "vitest";

import {
  parseStudioSnapshot,
  serializeStudioSnapshot,
  type StudioSnapshot,
} from "../lib/studio-state";

const IMAGE_ID = "cli-image-12345678-1234-4234-8234-123456789012";
const VIDEO_ID = "cli-video-87654321-4321-4321-8321-210987654321";
const BACKEND_IMAGE_ID = "gen-image-12345678-1234-4234-8234-123456789012";

describe("studio state persistence", () => {
  it("round-trips generated assets and editor settings", () => {
    const snapshot: StudioSnapshot = {
      version: 1,
      step: 3,
      imagePrompt: "Editorial portrait",
      motionPrompt: "Slow push in",
      image: { requestId: IMAGE_ID, url: "https://cdn.example/image.png" },
      video: { requestId: VIDEO_ID, url: "https://cdn.example/video.mp4" },
      duration: 8,
      resolution: "1080",
      cameraFixed: true,
      title: { text: "Saved title", x: 0.2, y: 0.3, fontSize: 72 },
      musicVolume: 0.35,
    };

    expect(parseStudioSnapshot(serializeStudioSnapshot(snapshot))).toEqual(snapshot);
  });

  it("rejects unsafe asset values and returns to the first incomplete step", () => {
    const restored = parseStudioSnapshot(
      JSON.stringify({
        version: 1,
        step: 3,
        image: { requestId: "../../credentials.json", url: "javascript:alert(1)" },
        video: { requestId: VIDEO_ID, url: "//evil.example/video.mp4" },
        title: { text: "Title", x: -20, y: 20, fontSize: 900 },
      }),
    );

    expect(restored).toMatchObject({
      step: 1,
      image: { requestId: "", url: "" },
      video: { requestId: VIDEO_ID, url: "" },
      title: { x: 0.02, y: 0.84, fontSize: 132 },
    });
  });

  it("accepts opaque generation IDs issued by the backend", () => {
    const restored = parseStudioSnapshot(
      JSON.stringify({
        version: 1,
        step: 2,
        image: { requestId: BACKEND_IMAGE_ID, url: "/media/projects/demo/image.png" },
      }),
    );

    expect(restored?.image).toEqual({
      requestId: BACKEND_IMAGE_ID,
      url: "/media/projects/demo/image.png",
    });
  });

  it("ignores corrupt or unknown snapshot versions", () => {
    expect(parseStudioSnapshot("not-json")).toBeNull();
    expect(parseStudioSnapshot(JSON.stringify({ version: 2 }))).toBeNull();
  });
});
