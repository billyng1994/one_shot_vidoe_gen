import { describe, expect, it } from "vitest";

import { mediaDownloadFilename } from "../lib/media-download";

describe("media download filenames", () => {
  it("preserves supported image and video extensions", () => {
    expect(mediaDownloadFilename("image", "/media/project/images/frame.webp?version=2"))
      .toBe("onetake-first-frame.webp");
    expect(mediaDownloadFilename("video", "https://media.example/output.WEBM#preview"))
      .toBe("onetake-unedited-video.webm");
  });

  it("uses workflow defaults for missing or mismatched extensions", () => {
    expect(mediaDownloadFilename("image", "/media/project/images/frame"))
      .toBe("onetake-first-frame.png");
    expect(mediaDownloadFilename("video", "/media/project/videos/output.png"))
      .toBe("onetake-unedited-video.mp4");
  });
});
