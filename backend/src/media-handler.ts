import { createReadStream } from "node:fs";

import type { NextFunction, Request, Response } from "express";

import { BackendError } from "./errors.js";
import { contentTypeForFilename, type MediaStorage } from "./media-storage.js";

function parseRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size === 0) return undefined;
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return undefined;

  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      return undefined;
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function createMediaHandler(storage: MediaStorage) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.set("Allow", "GET, HEAD").status(405).json({ error: "Method not allowed." });
        return;
      }

      const rawPath = request.url.split("?", 1)[0] ?? "";
      if (rawPath.includes("%") || rawPath.includes("\\")) {
        throw new BackendError("Invalid media path.", 400, "INVALID_MEDIA_PATH");
      }
      const relativePath = rawPath.replace(/^\/+/, "");
      const file = await storage.resolvePublicFile(relativePath);
      const rangeHeader = request.headers.range;
      const range = rangeHeader ? parseRange(rangeHeader, file.size) : undefined;

      response.set({
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": contentTypeForFilename(file.parsed.filename),
        "X-Content-Type-Options": "nosniff",
      });
      if (file.parsed.filename.endsWith(".svg")) {
        response.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }

      if (rangeHeader && !range) {
        response.set("Content-Range", `bytes */${file.size}`).status(416).end();
        return;
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, file.size - 1);
      response.set("Content-Length", String(file.size === 0 ? 0 : end - start + 1));
      if (range) {
        response.set("Content-Range", `bytes ${start}-${end}/${file.size}`).status(206);
      } else {
        response.status(200);
      }
      if (request.method === "HEAD" || file.size === 0) {
        response.end();
        return;
      }

      const stream = createReadStream(file.path, { start, end });
      stream.on("error", (error) => {
        if (response.headersSent) response.destroy(error);
        else next(error);
      });
      request.on("aborted", () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      next(error);
    }
  };
}
