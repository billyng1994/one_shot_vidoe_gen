import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isIP } from "node:net";
import { basename, extname, join, resolve, sep } from "node:path";

import { BackendError } from "./errors.js";
import type { StoredMedia } from "./job-store.js";
import {
  assertProjectId,
  mediaRelativePath,
  parseBackendRequestId,
  parseMediaRelativePath,
  type GenerationKind,
} from "./validation.js";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Lookup = typeof dnsLookup;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 4;
const DOWNLOAD_TIMEOUT_MS = 90_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function isPrivateAddress(address: string) {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

async function assertPublicHttpsUrl(url: URL, lookup: Lookup) {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hostname.toLowerCase() === "localhost"
  ) {
    throw new BackendError("The provider returned an unsafe media URL.", 502, "UNSAFE_PROVIDER_URL");
  }

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new BackendError("The provider media host is not public.", 502, "UNSAFE_PROVIDER_URL");
  }
}

function combineSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchProviderResponse(
  initialUrl: string,
  fetcher: Fetch,
  lookup: Lookup,
  signal?: AbortSignal,
) {
  let url: URL;
  try {
    url = new URL(initialUrl);
  } catch {
    throw new BackendError("The provider returned an invalid media URL.", 502, "INVALID_PROVIDER_URL");
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHttpsUrl(url, lookup);
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { Accept: "image/*, video/*;q=0.9" },
        redirect: "manual",
        signal: combineSignal(signal),
      });
    } catch {
      if (signal?.aborted) {
        throw new BackendError("The provider media download was canceled.", 408, "DOWNLOAD_CANCELED");
      }
      throw new BackendError("The provider media could not be downloaded.", 502, "DOWNLOAD_FAILED");
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirects === MAX_REDIRECTS) {
        throw new BackendError("The provider media redirected too many times.", 502, "DOWNLOAD_REDIRECT");
      }
      try {
        url = new URL(location, url);
      } catch {
        throw new BackendError("The provider returned an invalid redirect.", 502, "DOWNLOAD_REDIRECT");
      }
      continue;
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new BackendError("The provider media could not be downloaded.", 502, "DOWNLOAD_FAILED");
    }
    return response;
  }

  throw new BackendError("The provider media could not be downloaded.", 502, "DOWNLOAD_FAILED");
}

function sniffMedia(bytes: Buffer, kind: GenerationKind) {
  const ascii = bytes.toString("ascii");
  if (kind === "image") {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      return { extension: ".png", contentType: "image/png" };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { extension: ".jpg", contentType: "image/jpeg" };
    }
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
      return { extension: ".webp", contentType: "image/webp" };
    }
    if (ascii.slice(4, 12).includes("ftypavif") || ascii.slice(4, 12).includes("ftypavis")) {
      return { extension: ".avif", contentType: "image/avif" };
    }
  } else {
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return { extension: ".webm", contentType: "video/webm" };
    }
    if (ascii.slice(4, 8) === "ftyp") {
      return { extension: ".mp4", contentType: "video/mp4" };
    }
  }

  throw new BackendError(
    `The provider did not return a valid ${kind} file.`,
    502,
    "INVALID_MEDIA_FILE",
  );
}

function checkDeclaredMime(response: Response, detected: { contentType: string }) {
  const declared = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!declared || declared === "application/octet-stream") return;
  if (declared !== detected.contentType) {
    throw new BackendError("The provider media type did not match its content.", 502, "INVALID_MEDIA_TYPE");
  }
}

async function writeChunks(
  temporaryPath: string,
  chunks: AsyncIterable<Uint8Array>,
  maximumBytes: number,
) {
  const handle = await open(temporaryPath, "wx", 0o600);
  let bytes = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const rawChunk of chunks) {
      const chunk = Buffer.from(rawChunk);
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        throw new BackendError("The media file is too large.", 413, "MEDIA_TOO_LARGE");
      }
      if (prefix.byteLength < 32) {
        prefix = Buffer.concat([prefix, chunk]).subarray(0, 32);
      }
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (bytes === 0) {
    throw new BackendError("The media file is empty.", 502, "EMPTY_MEDIA_FILE");
  }
  return { bytes, prefix };
}

export class MediaStorage {
  readonly mediaDirectory: string;

  constructor(
    dataDirectory: string,
    private readonly assetsDirectory: string,
    private readonly limits: { image: number; video: number },
    private readonly fetcher: Fetch = fetch,
    private readonly lookup: Lookup = dnsLookup,
  ) {
    this.mediaDirectory = join(dataDirectory, "media");
  }

  async initialize() {
    await mkdir(this.mediaDirectory, { recursive: true });
  }

  async writable() {
    const probe = join(this.mediaDirectory, `.write-probe-${randomUUID()}`);
    try {
      await this.initialize();
      const handle = await open(probe, "wx", 0o600);
      await handle.close();
      return true;
    } catch {
      return false;
    } finally {
      await rm(probe, { force: true }).catch(() => undefined);
    }
  }

  private async categoryDirectory(projectId: string, kind: GenerationKind) {
    assertProjectId(projectId);
    const directory = join(this.mediaDirectory, projectId, kind === "image" ? "images" : "videos");
    await mkdir(directory, { recursive: true });
    const root = await realpath(this.mediaDirectory);
    const resolved = await realpath(directory);
    const expected = join(root, projectId, kind === "image" ? "images" : "videos");
    if (resolved !== expected) {
      throw new BackendError("The media directory is unsafe.", 500, "UNSAFE_MEDIA_DIRECTORY");
    }
    return resolved;
  }

  async storeProviderMedia(input: {
    kind: GenerationKind;
    projectId: string;
    providerUrl: string;
    requestId: string;
    signal?: AbortSignal;
  }): Promise<StoredMedia> {
    const request = parseBackendRequestId(input.requestId);
    if (request.kind !== input.kind) {
      throw new BackendError("The media kind does not match the request.", 500, "JOB_KIND_MISMATCH");
    }
    const response = await fetchProviderResponse(
      input.providerUrl,
      this.fetcher,
      this.lookup,
      input.signal,
    );
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const maximum = this.limits[input.kind];
    if (Number.isFinite(contentLength) && contentLength > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new BackendError("The provider media is too large.", 413, "MEDIA_TOO_LARGE");
    }

    const directory = await this.categoryDirectory(input.projectId, input.kind);
    const temporary = join(directory, `.${input.requestId}.${randomUUID()}.download`);
    try {
      const result = await writeChunks(
        temporary,
        response.body as unknown as AsyncIterable<Uint8Array>,
        maximum,
      );
      const detected = sniffMedia(result.prefix, input.kind);
      checkDeclaredMime(response, detected);
      const filename = `${input.requestId}${detected.extension}`;
      const relativePath = mediaRelativePath(
        input.projectId,
        input.kind === "image" ? "images" : "videos",
        filename,
      );
      await rename(temporary, join(directory, filename));
      return { bytes: result.bytes, contentType: detected.contentType, relativePath };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async storeBundledDemo(input: {
    kind: GenerationKind;
    projectId: string;
    requestId: string;
  }): Promise<StoredMedia> {
    const request = parseBackendRequestId(input.requestId);
    if (request.kind !== input.kind) {
      throw new BackendError("The demo media kind does not match the request.", 500, "JOB_KIND_MISMATCH");
    }
    const sourceName = input.kind === "image" ? "demo-image.svg" : "demo-video.mp4";
    const extension = extname(sourceName);
    const source = join(this.assetsDirectory, sourceName);
    if (basename(source) !== sourceName) {
      throw new BackendError("The bundled demo media path is invalid.", 500, "INVALID_ASSET_PATH");
    }
    const directory = await this.categoryDirectory(input.projectId, input.kind);
    const temporary = join(directory, `.${input.requestId}.${randomUUID()}.tmp`);
    try {
      const result = await writeChunks(
        temporary,
        createReadStream(source) as unknown as AsyncIterable<Uint8Array>,
        this.limits[input.kind],
      );
      const filename = `${input.requestId}${extension}`;
      const relativePath = mediaRelativePath(
        input.projectId,
        input.kind === "image" ? "images" : "videos",
        filename,
      );
      await rename(temporary, join(directory, filename));
      return {
        bytes: result.bytes,
        contentType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
        relativePath,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BackendError("The bundled demo media is missing.", 500, "MISSING_DEMO_ASSET");
      }
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async resolveFile(relativePath: string) {
    const parsed = parseMediaRelativePath(relativePath);
    await this.initialize();
    const root = await realpath(this.mediaDirectory);
    const candidate = resolve(this.mediaDirectory, parsed.relativePath);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BackendError("Media not found.", 404, "MEDIA_NOT_FOUND");
      }
      throw error;
    }
    const expectedProjectDirectory = join(root, parsed.projectId);
    if (!resolved.startsWith(`${expectedProjectDirectory}${sep}`)) {
      throw new BackendError("Invalid media path.", 400, "INVALID_MEDIA_PATH");
    }
    const metadata = await stat(resolved);
    if (!metadata.isFile()) {
      throw new BackendError("Media not found.", 404, "MEDIA_NOT_FOUND");
    }
    return { path: resolved, size: metadata.size, parsed };
  }

  async resolvePublicFile(relativePath: string) {
    if (relativePath === "samples/demo-image.svg" || relativePath === "samples/demo-video.mp4") {
      const filename = relativePath.slice("samples/".length);
      const assetsRoot = await realpath(this.assetsDirectory);
      const resolved = await realpath(join(this.assetsDirectory, filename)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new BackendError("Media not found.", 404, "MEDIA_NOT_FOUND");
        }
        throw error;
      });
      if (!resolved.startsWith(`${assetsRoot}${sep}`)) {
        throw new BackendError("Invalid media path.", 400, "INVALID_MEDIA_PATH");
      }
      const metadata = await stat(resolved);
      if (!metadata.isFile()) {
        throw new BackendError("Media not found.", 404, "MEDIA_NOT_FOUND");
      }
      return {
        path: resolved,
        size: metadata.size,
        parsed: { projectId: "samples", category: "samples", filename, relativePath },
      };
    }
    return this.resolveFile(relativePath);
  }

  async createRenderTarget(projectId: string, filename: string) {
    const relativePath = mediaRelativePath(projectId, "renders", filename);
    const directory = join(this.mediaDirectory, projectId, "renders");
    await mkdir(directory, { recursive: true });
    const root = await realpath(this.mediaDirectory);
    const resolvedDirectory = await realpath(directory);
    if (resolvedDirectory !== join(root, projectId, "renders")) {
      throw new BackendError("The render directory is unsafe.", 500, "UNSAFE_MEDIA_DIRECTORY");
    }
    return {
      relativePath,
      destination: join(resolvedDirectory, filename),
      temporary: join(resolvedDirectory, `.${filename}.${randomUUID()}.tmp.mp4`),
    };
  }

  async deleteProject(projectId: string) {
    assertProjectId(projectId);
    await rm(join(this.mediaDirectory, projectId), { recursive: true, force: true });
  }
}

export function contentTypeForFilename(filename: string) {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? "application/octet-stream";
}
