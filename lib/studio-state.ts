import { clampNumber, DEFAULT_TITLE, type TitlePlacement } from "./composition";

export const STUDIO_STORAGE_KEY = "onetake:studio:v1";

export type PersistedAsset = {
  requestId: string;
  url: string;
};

export type StudioSnapshot = {
  version: 1;
  step: 1 | 2 | 3;
  imagePrompt: string;
  motionPrompt: string;
  image: PersistedAsset;
  video: PersistedAsset;
  duration: 5 | 8 | 10;
  resolution: "720" | "1080";
  cameraFixed: boolean;
  title: TitlePlacement;
  musicVolume: number;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeRequestId(value: unknown, kind: "image" | "video") {
  if (typeof value !== "string") return "";
  const cliPattern = new RegExp(
    `^cli-${kind}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "i",
  );
  const demoPattern = new RegExp(`^demo-${kind}-\\d+$`);
  return cliPattern.test(value) || demoPattern.test(value) ? value : "";
}

function safeMediaUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4_096) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  try {
    return new URL(value).protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

function asset(value: unknown, kind: "image" | "video"): PersistedAsset {
  const candidate = record(value);
  return {
    requestId: safeRequestId(candidate?.requestId, kind),
    url: safeMediaUrl(candidate?.url),
  };
}

export function serializeStudioSnapshot(snapshot: StudioSnapshot) {
  return JSON.stringify(snapshot);
}

export function parseStudioSnapshot(value: string | null): StudioSnapshot | null {
  if (!value) return null;

  try {
    const parsed = record(JSON.parse(value));
    if (!parsed || parsed.version !== 1) return null;

    const image = asset(parsed.image, "image");
    const video = asset(parsed.video, "video");
    const storedTitle = record(parsed.title);
    const requestedStep = parsed.step === 2 || parsed.step === 3 ? parsed.step : 1;
    const step = !image.url ? 1 : requestedStep === 3 && !video.url ? 2 : requestedStep;
    const duration = parsed.duration === 8 || parsed.duration === 10 ? parsed.duration : 5;
    const resolution = parsed.resolution === "1080" ? "1080" : "720";

    return {
      version: 1,
      step,
      imagePrompt: boundedString(parsed.imagePrompt, 4_000),
      motionPrompt: boundedString(parsed.motionPrompt, 4_000),
      image,
      video,
      duration,
      resolution,
      cameraFixed: parsed.cameraFixed === true,
      title: {
        text: boundedString(storedTitle?.text, 180) || DEFAULT_TITLE.text,
        x: clampNumber(finiteNumber(storedTitle?.x, DEFAULT_TITLE.x), 0.02, 0.82),
        y: clampNumber(finiteNumber(storedTitle?.y, DEFAULT_TITLE.y), 0.13, 0.84),
        fontSize: clampNumber(
          finiteNumber(storedTitle?.fontSize, DEFAULT_TITLE.fontSize),
          48,
          132,
        ),
      },
      musicVolume: clampNumber(finiteNumber(parsed.musicVolume, 0.24), 0, 1),
    };
  } catch {
    return null;
  }
}
