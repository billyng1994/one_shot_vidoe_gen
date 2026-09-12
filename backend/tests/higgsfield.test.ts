import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findRecentHiggsfieldImage,
  getHiggsfieldGeneration,
  HiggsfieldError,
  submitHiggsfieldImage,
  submitHiggsfieldVideo,
  type CliRunner,
} from "../src/higgsfield.js";

const ORIGINAL_ENV = { ...process.env };
const IMAGE_JOB_ID = "12345678-1234-4234-8234-123456789012";
const VIDEO_JOB_ID = "87654321-4321-4321-8321-210987654321";

function result(value: unknown) {
  return Promise.resolve({ stdout: JSON.stringify(value), stderr: "" });
}

function schema(jobType: string, type: "image" | "video") {
  const names = type === "video"
    ? ["prompt", "start_image", "duration", "resolution", "aspect_ratio", "mode", "generate_audio"]
    : ["prompt", "aspect_ratio", "quality", "resolution"];
  return { job_type: jobType, type, params: names.map((name) => ({ name })) };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("backend Higgsfield CLI adapter", () => {
  it.each(["waiting", "script", "visuals", "flow", "vision", "dna"])(
    "keeps the Higgsfield %s phase in progress",
    async (status) => {
      const runner = vi
        .fn<CliRunner>()
        .mockImplementationOnce(() => result({ help: true }))
        .mockImplementationOnce(() => result({ help: true }))
        .mockImplementationOnce(() => result({ authenticated: true }))
        .mockImplementationOnce(() => result({ id: VIDEO_JOB_ID, status }));

      await expect(
        getHiggsfieldGeneration(`cli-video-${VIDEO_JOB_ID}`, { runner }),
      ).resolves.toEqual({
        status: "in_progress",
        request_id: `cli-video-${VIDEO_JOB_ID}`,
      });
    },
  );

  it("maps Higgsfield's IP-detection terminal state to a safety rejection", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ id: VIDEO_JOB_ID, status: "ip_detected" }));

    await expect(
      getHiggsfieldGeneration(`cli-video-${VIDEO_JOB_ID}`, { runner }),
    ).resolves.toEqual({
      status: "nsfw",
      request_id: `cli-video-${VIDEO_JOB_ID}`,
    });
  });

  it("keeps an unknown provider phase nonterminal until Higgsfield reports an outcome", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ id: VIDEO_JOB_ID, status: "future_pipeline_phase" }));

    await expect(
      getHiggsfieldGeneration(`cli-video-${VIDEO_JOB_ID}`, { runner }),
    ).resolves.toEqual({
      status: "in_progress",
      request_id: `cli-video-${VIDEO_JOB_ID}`,
    });
  });

  it("keeps an explicit provider error terminal when its status is unknown", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({
        error: "Provider rejected the request.",
        id: VIDEO_JOB_ID,
        status: "future_terminal_phase",
      }));

    await expect(
      getHiggsfieldGeneration(`cli-video-${VIDEO_JOB_ID}`, { runner }),
    ).resolves.toEqual({
      error: "Provider rejected the request.",
      status: "failed",
      request_id: `cli-video-${VIDEO_JOB_ID}`,
    });
  });

  it("does not treat an informational provider message as a failure", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({
        id: VIDEO_JOB_ID,
        message: "Preparing the next pipeline stage.",
        status: "future_pipeline_phase",
      }));

    await expect(
      getHiggsfieldGeneration(`cli-video-${VIDEO_JOB_ID}`, { runner }),
    ).resolves.toEqual({
      status: "in_progress",
      request_id: `cli-video-${VIDEO_JOB_ID}`,
    });
  });

  it("authenticates and checks the model schema before passing a prompt as one argv", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("gpt_image_2", "image")))
      .mockImplementationOnce(() => result({ id: IMAGE_JOB_ID, job_type: "gpt_image_2" }));
    const prompt = "Portrait; $(touch /tmp/nope) && echo unsafe";

    await expect(submitHiggsfieldImage(prompt, { runner })).resolves.toEqual({
      status: "queued",
      request_id: `cli-image-${IMAGE_JOB_ID}`,
    });
    expect(runner).toHaveBeenNthCalledWith(
      3,
      ["auth", "token"],
      expect.objectContaining({ discardStdout: true }),
    );
    expect(runner.mock.calls[5]?.[0]).toEqual([
      "--json",
      "--no-color",
      "generate",
      "create",
      "gpt_image_2",
      `--prompt=${prompt}`,
      "--aspect_ratio=1:1",
      "--quality=high",
      "--resolution=2k",
    ]);
  });

  it("recovers a matching recent job when create output omits the ID", async () => {
    const prompt = "A quiet classroom in documentary light";
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("gpt_image_2", "image")))
      .mockResolvedValueOnce({ stdout: "Generation submitted.\n", stderr: "" })
      .mockImplementationOnce(() => result([
        {
          created_at: new Date().toISOString(),
          id: IMAGE_JOB_ID,
          job_type: "gpt_image_2",
          params: { aspect_ratio: "1:1", prompt },
          status: "queued",
        },
      ]));

    await expect(submitHiggsfieldImage(prompt, { runner })).resolves.toMatchObject({
      request_id: `cli-image-${IMAGE_JOB_ID}`,
    });
    expect(runner.mock.calls[6]?.[0]).toEqual([
      "--json",
      "--no-color",
      "generate",
      "list",
      "--image",
      "--size",
      "20",
    ]);
  });

  it("uses the provider image UUID, never its URL, as Seedance's first frame", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("seedance_2_0", "video")))
      .mockImplementationOnce(() => result({
        id: IMAGE_JOB_ID,
        status: "completed",
        result_url: "https://cdn.example/image.png",
      }))
      .mockImplementationOnce(() => result({ id: VIDEO_JOB_ID, job_type: "seedance_2_0" }));

    await submitHiggsfieldVideo(
      {
        cameraFixed: false,
        duration: 5,
        imageRequestId: `cli-image-${IMAGE_JOB_ID}`,
        prompt: "Move slowly.",
        resolution: "720",
      },
      { runner },
    );
    const args = runner.mock.calls[6]?.[0] ?? [];
    expect(args).toContain(`--start-image=${IMAGE_JOB_ID}`);
    expect(args.join("\n")).not.toContain("cdn.example");
  });

  it("does not find unrelated recent prompts", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result([
        {
          created_at: new Date().toISOString(),
          id: IMAGE_JOB_ID,
          job_type: "gpt_image_2",
          params: { prompt: "Something else" },
          status: "queued",
        },
      ]));

    await expect(findRecentHiggsfieldImage("Exact prompt", { runner })).resolves.toBeUndefined();
  });

  it("rejects a mismatched installed model schema", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ job_type: "gpt_image_2", type: "image", params: [] }));

    await expect(submitHiggsfieldImage("A portrait", { runner })).rejects.toEqual(
      new HiggsfieldError(
        "The installed Higgsfield CLI schema for “gpt_image_2” does not match this app.",
        503,
      ),
    );
  });
});
