import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import sharp from "sharp";

import {
  BRAND_LOGO_RECT,
  clampNumber,
  createOverlaySvg,
  type TitlePlacement,
} from "@/lib/composition";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_MUSIC_BYTES = 40 * 1024 * 1024;

class RenderError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function parseNumber(value: FormDataEntryValue | null, fallback: number) {
  if (typeof value !== "string") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (/^(127|0|10)\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  if (/^169\.254\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

async function getVideoBytes(videoUrl: string) {
  if (videoUrl.startsWith("/demo/")) {
    const demoRoot = resolve(process.cwd(), "public", "demo");
    const localPath = resolve(process.cwd(), "public", `.${videoUrl}`);
    if (!localPath.startsWith(`${demoRoot}${sep}`)) {
      throw new RenderError("Invalid local demo video path.", 400);
    }
    return readFile(localPath);
  }

  let url: URL;
  try {
    url = new URL(videoUrl);
  } catch {
    throw new RenderError("The generated video URL is invalid.", 400);
  }

  if (url.protocol !== "https:" || isBlockedHostname(url.hostname)) {
    throw new RenderError("Only public HTTPS video URLs can be rendered.", 400);
  }

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    throw new RenderError("The generated video could not be downloaded.", 502);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_VIDEO_BYTES) {
    throw new RenderError("The generated video is larger than 200 MB.", 413);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_VIDEO_BYTES) {
    throw new RenderError("The generated video is larger than 200 MB.", 413);
  }
  return bytes;
}

function run(binary: string, args: string[]) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(/* turbopackIgnore: true */ binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-24_000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new RenderError(
            `${binary} was not found. Install FFmpeg or set its path in .env.local.`,
            503,
          ),
        );
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stderr);
      else reject(new RenderError(`FFmpeg render failed. ${stderr.trim()}`, 500));
    });
  });
}

async function probeDuration(videoPath: string) {
  const output: string[] = [];
  const binary = process.env.FFPROBE_PATH || "ffprobe";

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ binary,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new RenderError(
            `${binary} was not found. Install FFmpeg or set FFPROBE_PATH in .env.local.`,
            503,
          ),
        );
      } else reject(error);
    });
    child.on("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new RenderError("Could not read the generated video.", 400)),
    );
  });

  const duration = Number(output.join("").trim());
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120) {
    throw new RenderError("The generated video has an invalid duration.", 400);
  }
  return duration;
}

export async function POST(request: Request) {
  let workDirectory: string | undefined;

  try {
    const form = await request.formData();
    const videoUrl = form.get("videoUrl");
    const titleText = form.get("title");
    const music = form.get("music");

    if (typeof videoUrl !== "string" || !videoUrl) {
      throw new RenderError("A generated video is required.", 400);
    }
    if (typeof titleText !== "string" || titleText.trim().length > 180) {
      throw new RenderError("Title must be 180 characters or fewer.", 400);
    }
    if (music instanceof File && music.size > MAX_MUSIC_BYTES) {
      throw new RenderError("Background music must be 40 MB or smaller.", 413);
    }

    const title: TitlePlacement = {
      text: titleText,
      x: clampNumber(parseNumber(form.get("titleX"), 0.055), 0.02, 0.92),
      y: clampNumber(parseNumber(form.get("titleY"), 0.165), 0.13, 0.84),
      fontSize: clampNumber(parseNumber(form.get("fontSize"), 86), 48, 132),
    };
    const volume = clampNumber(parseNumber(form.get("musicVolume"), 0.24), 0, 1);

    workDirectory = await mkdtemp(join(tmpdir(), "one-shot-render-"));
    const inputPath = join(workDirectory, "input-video");
    const overlayPath = join(workDirectory, "overlay.png");
    const musicPath = join(workDirectory, "music-input");
    const outputPath = join(workDirectory, "one-shot.mp4");

    await writeFile(inputPath, await getVideoBytes(videoUrl));
    const logo = await sharp(resolve(process.cwd(), "public", "gostudy-logo.svg"))
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

    const hasMusic = music instanceof File && music.size > 0;
    if (hasMusic) {
      await writeFile(musicPath, Buffer.from(await music.arrayBuffer()));
    }

    const duration = await probeDuration(inputPath);
    const fadeStart = Math.max(0, duration - 0.7).toFixed(3);
    const durationString = duration.toFixed(3);
    const videoFilter = [
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
      inputPath,
      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      overlayPath,
    ];

    if (hasMusic) {
      args.push("-stream_loop", "-1", "-i", musicPath);
      videoFilter.push(
        `[2:a:0]volume=${volume.toFixed(3)},atrim=0:${durationString},asetpts=N/SR/TB,afade=t=out:st=${fadeStart}:d=0.7[aout]`,
      );
    }

    args.push(
      "-filter_complex",
      videoFilter.join(";"),
      "-map",
      "[vout]",
    );

    if (hasMusic) args.push("-map", "[aout]");
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
      outputPath,
    );

    await run(process.env.FFMPEG_PATH || "ffmpeg", args);
    const result = await readFile(outputPath);

    return new Response(new Uint8Array(result), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="one-shot-${Date.now()}.mp4"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const status = error instanceof RenderError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "The final video could not be rendered.";
    return Response.json({ error: message }, { status });
  } finally {
    if (workDirectory) {
      await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
