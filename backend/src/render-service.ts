import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import {
  BRAND_LOGO_RECT,
  clampNumber,
  createOverlaySvg,
  type TitlePlacement,
} from "./composition.js";
import { BackendError } from "./errors.js";
import type { MediaStorage } from "./media-storage.js";
import { Semaphore } from "./semaphore.js";
import { assertProjectId, mediaUrl, parseLocalMediaUrl } from "./validation.js";

const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const RENDER_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const GENERATED_VIDEO_PATTERN =
  /^gen-video-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:mp4|webm)$/i;

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (
  binary: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

function childEnvironment() {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "PATH", "TMPDIR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

export const runCommand: CommandRunner = (binary, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      env: childEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      if (settled) return;
      child.kill("SIGTERM");
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        forceKillTimer.unref();
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();

    const append = (current: string, chunk: Buffer | string) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT_BYTES) {
        outputTooLarge = true;
        terminate();
        return current;
      }
      return next;
    };
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    const cleanUp = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanUp();
      if (error.code === "ENOENT") {
        reject(new BackendError(`${binary} was not found.`, 503, "BINARY_NOT_FOUND"));
      } else {
        reject(new BackendError(`${binary} could not be started.`, 500, "PROCESS_START_FAILED"));
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanUp();
      if (timedOut) {
        reject(new BackendError(`${binary} timed out.`, 504, "PROCESS_TIMEOUT"));
      } else if (outputTooLarge) {
        reject(new BackendError(`${binary} returned too much output.`, 500, "PROCESS_OUTPUT_LIMIT"));
      } else if (code !== 0) {
        reject(new BackendError(`${binary} failed while rendering media.`, 500, "PROCESS_FAILED"));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

function parseNumber(value: unknown, fallback: number) {
  if (typeof value !== "string") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validateMusic(file: Express.Multer.File | undefined, maximumBytes: number) {
  if (!file || file.size === 0) return undefined;
  if (file.size > maximumBytes) {
    throw new BackendError(
      `Background music must be ${Math.floor(maximumBytes / 1024 / 1024)} MB or smaller.`,
      413,
      "MUSIC_TOO_LARGE",
    );
  }
  if (
    file.mimetype &&
    !file.mimetype.startsWith("audio/") &&
    file.mimetype !== "application/octet-stream"
  ) {
    throw new BackendError("Background music must be an audio file.", 400, "INVALID_MUSIC_TYPE");
  }
  return file.buffer;
}

export type RenderInput = {
  fields: Record<string, unknown>;
  music?: Express.Multer.File;
};

export class RenderService {
  private readonly concurrency: Semaphore;

  constructor(
    private readonly media: MediaStorage,
    private readonly assetsDirectory: string,
    private readonly options: {
      ffmpegPath: string;
      ffprobePath: string;
      maxMusicBytes: number;
      maxVideoBytes: number;
      concurrency: number;
    },
    private readonly runner: CommandRunner = runCommand,
  ) {
    this.concurrency = new Semaphore(options.concurrency);
  }

  async render(input: RenderInput) {
    return this.concurrency.use(() => this.renderUnbounded(input));
  }

  private async resolveInputVideo(value: unknown, projectId: string) {
    if (value === "/media/samples/demo-video.mp4") {
      return this.media.resolvePublicFile("samples/demo-video.mp4");
    }
    const parsed = parseLocalMediaUrl(value, projectId);
    if (parsed.category !== "videos" || !GENERATED_VIDEO_PATTERN.test(parsed.filename)) {
      throw new BackendError(
        "A project-owned generated video is required.",
        400,
        "INVALID_RENDER_VIDEO",
      );
    }
    return this.media.resolveFile(parsed.relativePath);
  }

  private async probeDuration(videoPath: string) {
    const result = await this.runner(
      this.options.ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      PROBE_TIMEOUT_MS,
    );
    const duration = Number(result.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0 || duration > 120) {
      throw new BackendError("The generated video has an invalid duration.", 400, "INVALID_DURATION");
    }
    return duration;
  }

  private async renderUnbounded(input: RenderInput) {
    const projectId = input.fields.projectId;
    assertProjectId(projectId);
    const titleText = typeof input.fields.title === "string" ? input.fields.title : "";
    if (titleText.trim().length > 180) {
      throw new BackendError("Title must be 180 characters or fewer.", 400, "INVALID_TITLE");
    }
    const title: TitlePlacement = {
      text: titleText,
      x: clampNumber(parseNumber(input.fields.titleX, 0.055), 0.02, 0.92),
      y: clampNumber(parseNumber(input.fields.titleY, 0.165), 0.13, 0.84),
      fontSize: clampNumber(parseNumber(input.fields.fontSize, 86), 48, 132),
    };
    const volume = clampNumber(parseNumber(input.fields.musicVolume, 0.24), 0, 1);
    const music = validateMusic(input.music, this.options.maxMusicBytes);
    const video = await this.resolveInputVideo(input.fields.videoUrl, projectId);

    let workDirectory: string | undefined;
    const filename = `one-shot-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`;
    const output = await this.media.createRenderTarget(projectId, filename);
    try {
      workDirectory = await mkdtemp(join(tmpdir(), "one-shot-render-"));
      const overlayPath = join(workDirectory, "overlay.png");
      const musicPath = join(workDirectory, "music-input");
      const logoPath = join(this.assetsDirectory, "gostudy-logo.svg");
      const logoSource = await readFile(logoPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new BackendError("The render logo asset is missing.", 500, "MISSING_LOGO_ASSET");
        }
        throw error;
      });
      const logo = await sharp(logoSource)
        .resize({
          width: BRAND_LOGO_RECT.width,
          height: BRAND_LOGO_RECT.height,
          fit: "fill",
        })
        .png()
        .toBuffer();
      await sharp(Buffer.from(createOverlaySvg(title)))
        .composite([
          {
            input: logo,
            left: BRAND_LOGO_RECT.x,
            top: BRAND_LOGO_RECT.y,
          },
        ])
        .png()
        .toFile(overlayPath);

      if (music) await writeFile(musicPath, music, { mode: 0o600 });
      const duration = await this.probeDuration(video.path);
      const fadeStart = Math.max(0, duration - 0.7).toFixed(3);
      const durationString = duration.toFixed(3);
      const filters = [
        "[0:v]scale=1080:1072:force_original_aspect_ratio=increase,crop=1080:1072,setsar=1[scaled]",
        `color=c=white:s=1080x1350:r=30:d=${durationString}[canvas]`,
        "[canvas][scaled]overlay=0:159:shortest=1[base]",
        "[base][1:v]overlay=0:0:shortest=1:format=auto[vout]",
      ];
      const args = [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video.path,
        "-loop",
        "1",
        "-framerate",
        "30",
        "-i",
        overlayPath,
      ];
      if (music) {
        args.push("-stream_loop", "-1", "-i", musicPath);
        filters.push(
          `[2:a:0]volume=${volume.toFixed(3)},atrim=0:${durationString},asetpts=N/SR/TB,afade=t=out:st=${fadeStart}:d=0.7[aout]`,
        );
      }
      args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
      if (music) args.push("-map", "[aout]");
      else args.push("-map", "0:a?");
      args.push(
        "-t",
        durationString,
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        "-f",
        "mp4",
        output.temporary,
      );
      await this.runner(this.options.ffmpegPath, args, RENDER_TIMEOUT_MS);
      const metadata = await stat(output.temporary);
      if (!metadata.isFile() || metadata.size === 0) {
        throw new BackendError("FFmpeg did not create a render.", 500, "EMPTY_RENDER");
      }
      if (metadata.size > this.options.maxVideoBytes) {
        throw new BackendError("The final render is too large.", 413, "RENDER_TOO_LARGE");
      }
      await rename(output.temporary, output.destination);
      return { url: mediaUrl(output.relativePath), filename };
    } finally {
      if (workDirectory) {
        await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(output.temporary, { force: true }).catch(() => undefined);
    }
  }
}
