import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaStorage } from "../src/media-storage.js";
import { RenderService, type CommandRunner } from "../src/render-service.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("render service", () => {
  it("atomically keeps the final FFmpeg result in project media storage", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "backend-render-test-"));
    temporaryDirectories.push(dataDirectory);
    const assetsDirectory = resolve(import.meta.dirname, "..", "assets");
    const media = new MediaStorage(
      dataDirectory,
      assetsDirectory,
      { image: 5 * 1024 * 1024, video: 5 * 1024 * 1024 },
    );
    const runner = vi.fn<CommandRunner>(async (binary, args) => {
      if (binary === "test-ffprobe") return { stdout: "5.0\n", stderr: "" };
      const outputPath = args.at(-1);
      if (!outputPath) throw new Error("Missing output path");
      await writeFile(outputPath, Buffer.from("fake-mp4-output"));
      return { stdout: "", stderr: "" };
    });
    const renderer = new RenderService(
      media,
      assetsDirectory,
      {
        concurrency: 1,
        ffmpegPath: "test-ffmpeg",
        ffprobePath: "test-ffprobe",
        maxMusicBytes: 1024,
        maxVideoBytes: 1024 * 1024,
      },
      runner,
    );

    const result = await renderer.render({
      fields: {
        projectId: PROJECT_ID,
        videoUrl: "/media/samples/demo-video.mp4",
        title: "A finished story",
        titleX: "0.1",
        titleY: "0.2",
        fontSize: "80",
        musicVolume: "0.2",
      },
    });

    expect(result.url).toMatch(new RegExp(`^/media/${PROJECT_ID}/renders/one-shot-`));
    const relativePath = result.url.slice("/media/".length);
    const stored = await media.resolveFile(relativePath);
    expect(await readFile(stored.path, "utf8")).toBe("fake-mp4-output");
    expect(runner).toHaveBeenCalledWith(
      "test-ffmpeg",
      expect.arrayContaining(["-f", "mp4"]),
      5 * 60_000,
    );
  });
});
