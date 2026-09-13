export type DownloadMediaKind = "image" | "video";

const DOWNLOAD_EXTENSIONS: Record<DownloadMediaKind, ReadonlySet<string>> = {
  image: new Set(["avif", "jpeg", "jpg", "png", "svg", "webp"]),
  video: new Set(["mp4", "webm"]),
};

const DOWNLOAD_NAMES: Record<DownloadMediaKind, string> = {
  image: "onetake-first-frame",
  video: "onetake-unedited-video",
};

const DEFAULT_EXTENSIONS: Record<DownloadMediaKind, string> = {
  image: "png",
  video: "mp4",
};

export function mediaDownloadFilename(kind: DownloadMediaKind, url: string) {
  let extension = "";

  try {
    const pathname = new URL(url, "https://onetake.invalid").pathname;
    extension = pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
  } catch {
    // Fall back to the workflow's standard output format for malformed legacy URLs.
  }

  const safeExtension = DOWNLOAD_EXTENSIONS[kind].has(extension)
    ? extension
    : DEFAULT_EXTENSIONS[kind];
  return `${DOWNLOAD_NAMES[kind]}.${safeExtension}`;
}
