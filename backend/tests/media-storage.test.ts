import type { lookup as dnsLookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaStorage } from "../src/media-storage.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "gen-image-22222222-2222-4222-8222-222222222222";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createStorage(
  fetcher: typeof fetch,
  lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "backend-media-test-"));
  temporaryDirectories.push(dataDirectory);
  return new MediaStorage(
    dataDirectory,
    resolve(import.meta.dirname, "..", "assets"),
    { image: 1024, video: 2048 },
    fetcher,
    lookup as unknown as typeof dnsLookup,
  );
}

describe("provider media localization", () => {
  it("streams a validated public provider image into an atomic local destination", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(PNG, {
      headers: { "content-length": String(PNG.length), "content-type": "image/png" },
    }));
    const storage = await createStorage(fetcher);

    const stored = await storage.storeProviderMedia({
      kind: "image",
      projectId: PROJECT_ID,
      providerUrl: "https://cdn.example.test/result",
      requestId: REQUEST_ID,
    });

    expect(stored.relativePath).toBe(`${PROJECT_ID}/images/${REQUEST_ID}.png`);
    expect((await storage.resolveFile(stored.relativePath)).size).toBe(PNG.length);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://cdn.example.test/result"),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("blocks private provider hosts before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const storage = await createStorage(fetcher);

    await expect(storage.storeProviderMedia({
      kind: "image",
      projectId: PROJECT_ID,
      providerUrl: "https://127.0.0.1/private.png",
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ status: 502, code: "UNSAFE_PROVIDER_URL" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects declared downloads over the configured byte limit", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(PNG, {
      headers: { "content-length": "2048", "content-type": "image/png" },
    }));
    const storage = await createStorage(fetcher);

    await expect(storage.storeProviderMedia({
      kind: "image",
      projectId: PROJECT_ID,
      providerUrl: "https://cdn.example.test/huge.png",
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ status: 413, code: "MEDIA_TOO_LARGE" });
  });
});
