import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobStore, publicGeneration, type GenerationJob } from "../src/job-store.js";
import { parseBackendRequestId, parseLocalMediaUrl } from "../src/validation.js";

const temporaryDirectories: string[] = [];
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "gen-image-22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "cli-image-33333333-3333-4333-8333-333333333333";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function job(): GenerationJob {
  const now = new Date().toISOString();
  return {
    version: 1,
    requestId: REQUEST_ID,
    providerRequestId: PROVIDER_ID,
    projectId: PROJECT_ID,
    kind: "image",
    prompt: "A portrait",
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
}

describe("durable job storage", () => {
  it("persists provider mappings atomically and exposes only backend IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "backend-store-test-"));
    temporaryDirectories.push(directory);
    const store = new JobStore(directory);
    await store.create(job());

    expect(await store.read(REQUEST_ID)).toMatchObject({ providerRequestId: PROVIDER_ID });
    expect(publicGeneration(await store.read(REQUEST_ID))).toEqual({
      status: "queued",
      request_id: REQUEST_ID,
    });
    const serialized = await readFile(join(directory, "jobs", `${REQUEST_ID}.json`), "utf8");
    expect(serialized).toContain(PROVIDER_ID);
    expect(serialized).not.toContain("https://");
  });

  it("accepts the legacy project sentinel but rejects traversal IDs and URLs", () => {
    expect(parseBackendRequestId(REQUEST_ID).kind).toBe("image");
    expect(parseLocalMediaUrl("/media/legacy-v1/videos/example.mp4").projectId).toBe("legacy-v1");
    expect(() => parseBackendRequestId("../../jobs/secret")).toThrow(/Invalid generation request ID/);
    expect(() => parseLocalMediaUrl("/media/legacy-v1/videos/%2e%2e%2fsecret")).toThrow(
      /backend-managed media/,
    );
  });
});
