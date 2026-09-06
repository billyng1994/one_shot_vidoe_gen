import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  findRecentHiggsfieldImage,
  findRecentHiggsfieldVideo,
  getHiggsfieldCliHealth,
  getImageModel,
  getVideoModel,
  HiggsfieldError,
  parsePublicRequestId,
  submitHiggsfieldImage,
  submitHiggsfieldVideo,
  type CliRunner,
} from "../lib/higgsfield";

const ORIGINAL_ENV = { ...process.env };
const IMAGE_JOB_ID = "12345678-1234-4234-8234-123456789012";
const VIDEO_JOB_ID = "87654321-4321-4321-8321-210987654321";

function result(value: unknown) {
  return Promise.resolve({ stdout: JSON.stringify(value), stderr: "" });
}

function schema(jobType: string, type: "image" | "video") {
  const names =
    type === "video"
      ? ["prompt", "start_image", "duration", "resolution", "aspect_ratio", "mode", "generate_audio"]
      : ["prompt", "aspect_ratio", "quality", "resolution"];
  return {
    job_type: jobType,
    type,
    params: names.map((name) => ({ name })),
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("Higgsfield CLI adapter", () => {
  it("uses GPT Image 2 and Seedance 2.0 by default", () => {
    delete process.env.HIGGSFIELD_IMAGE_MODEL;
    delete process.env.HIGGSFIELD_VIDEO_MODEL;

    expect(getImageModel()).toBe(DEFAULT_IMAGE_MODEL);
    expect(getVideoModel()).toBe(DEFAULT_VIDEO_MODEL);
  });

  it("rejects unsafe model overrides", () => {
    process.env.HIGGSFIELD_IMAGE_MODEL = "gpt_image_2; touch /tmp/nope";
    expect(() => getImageModel()).toThrow(/valid Higgsfield CLI job type/);
  });

  it("submits the prompt as one argv value after auth and schema preflight", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("gpt_image_2", "image")))
      .mockImplementationOnce(() =>
        result({ credits: 6.5, id: IMAGE_JOB_ID, job_type: "gpt_image_2" }),
      );
    const prompt = "Portrait; $(touch /tmp/nope) && echo unsafe";

    const response = await submitHiggsfieldImage(prompt, { runner });

    expect(response).toEqual({
      status: "queued",
      request_id: `cli-image-${IMAGE_JOB_ID}`,
    });
    expect(runner).toHaveBeenNthCalledWith(
      3,
      ["auth", "token"],
      expect.objectContaining({ discardStdout: true }),
    );
    const createArgs = runner.mock.calls[5][0];
    expect(createArgs).toContain(`--prompt=${prompt}`);
    expect(createArgs).toEqual([
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

  it("accepts the CLI's bare job ID fallback response", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("gpt_image_2", "image")))
      .mockResolvedValueOnce({
        stdout: `${IMAGE_JOB_ID}\n`,
        stderr: "",
      });

    await expect(submitHiggsfieldImage("A documentary portrait", { runner })).resolves.toEqual({
      status: "queued",
      request_id: `cli-image-${IMAGE_JOB_ID}`,
    });
  });

  it("recovers a submitted job when create returns no usable job ID", async () => {
    const prompt = "A quiet classroom in documentary light";
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("gpt_image_2", "image")))
      .mockResolvedValueOnce({ stdout: "Generation submitted.\n", stderr: "" })
      .mockImplementationOnce(() =>
        result([
          {
            created_at: new Date().toISOString(),
            id: IMAGE_JOB_ID,
            job_type: "gpt_image_2",
            params: { prompt },
            status: "queued",
          },
        ]),
      );

    await expect(submitHiggsfieldImage(prompt, { runner })).resolves.toEqual({
      status: "queued",
      request_id: `cli-image-${IMAGE_JOB_ID}`,
    });
    expect(runner).toHaveBeenNthCalledWith(
      7,
      ["--json", "--no-color", "generate", "list", "--image", "--size", "20"],
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
  });

  it("finds a recent matching image job without submitting another one", async () => {
    const prompt = "A quiet classroom in documentary light";
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() =>
        result([
          {
            created_at: new Date().toISOString(),
            id: IMAGE_JOB_ID,
            job_type: "gpt_image_2",
            params: { prompt },
            result_url: "https://cdn.example/recovered.png",
            status: "completed",
          },
        ]),
      );

    await expect(findRecentHiggsfieldImage(prompt, { runner })).resolves.toEqual({
      images: [{ url: "https://cdn.example/recovered.png" }],
      status: "completed",
      request_id: `cli-image-${IMAGE_JOB_ID}`,
    });
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it("uses the completed image job UUID as Seedance's first frame", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("seedance_2_0", "video")))
      .mockImplementationOnce(() =>
        result({ id: IMAGE_JOB_ID, status: "completed", result_url: "https://cdn.example/image.png" }),
      )
      .mockImplementationOnce(() =>
        result({ credits: 22.5, id: VIDEO_JOB_ID, job_type: "seedance_2_0" }),
      );

    const response = await submitHiggsfieldVideo(
      {
        cameraFixed: true,
        duration: 5,
        imageRequestId: `cli-image-${IMAGE_JOB_ID}`,
        prompt: "The subject smiles naturally.",
        resolution: "720",
      },
      { runner },
    );

    expect(response.request_id).toBe(`cli-video-${VIDEO_JOB_ID}`);
    const createArgs = runner.mock.calls[6][0];
    expect(createArgs).toContain(`--start-image=${IMAGE_JOB_ID}`);
    expect(createArgs).toContain(
      "--prompt=The subject smiles naturally.\nCamera remains locked off and motionless for the entire clip.",
    );
    expect(createArgs.join("\n")).not.toContain("https://cdn.example/image.png");
  });

  it("recovers a submitted Seedance job when create JSON omits its job ID", async () => {
    const prompt = "A gentle camera move";
    const effectivePrompt = `${prompt}\nCamera remains locked off and motionless for the entire clip.`;
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("seedance_2_0", "video")))
      .mockImplementationOnce(() =>
        result({ id: IMAGE_JOB_ID, status: "completed", result_url: "https://cdn.example/image.png" }),
      )
      .mockImplementationOnce(() => result({ status: "queued" }))
      .mockImplementationOnce(() =>
        result([
          {
            created_at: new Date().toISOString(),
            id: VIDEO_JOB_ID,
            job_type: "seedance_2_0",
            params: {
              aspect_ratio: "1:1",
              duration: 5,
              generate_audio: false,
              medias: [{ data: { id: IMAGE_JOB_ID }, role: "start_image" }],
              mode: "std",
              prompt: effectivePrompt,
              resolution: "720p",
            },
            status: "queued",
          },
        ]),
      );

    await expect(
      submitHiggsfieldVideo(
        {
          cameraFixed: true,
          duration: 5,
          imageRequestId: `cli-image-${IMAGE_JOB_ID}`,
          prompt,
          resolution: "720",
        },
        { runner },
      ),
    ).resolves.toEqual({
      status: "queued",
      request_id: `cli-video-${VIDEO_JOB_ID}`,
    });
  });

  it("finds the matching recent Seedance job without submitting a duplicate", async () => {
    const prompt = "A gentle camera move";
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() =>
        result([
          {
            created_at: new Date().toISOString(),
            id: VIDEO_JOB_ID,
            job_type: "seedance_2_0",
            params: {
              aspect_ratio: "1:1",
              duration: 5,
              generate_audio: false,
              medias: [{ data: { id: IMAGE_JOB_ID }, role: "start_image" }],
              mode: "std",
              prompt,
              resolution: "720p",
            },
            result_url: "https://cdn.example/recovered.mp4",
            status: "completed",
          },
        ]),
      );

    await expect(
      findRecentHiggsfieldVideo(
        {
          cameraFixed: false,
          duration: 5,
          imageRequestId: `cli-image-${IMAGE_JOB_ID}`,
          prompt,
          resolution: "720",
        },
        { runner },
      ),
    ).resolves.toEqual({
      status: "completed",
      request_id: `cli-video-${VIDEO_JOB_ID}`,
      video: { url: "https://cdn.example/recovered.mp4" },
    });
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it("rejects a video request that references a video job as its first frame", async () => {
    const runner = vi.fn<CliRunner>();

    await expect(
      submitHiggsfieldVideo(
        {
          cameraFixed: false,
          duration: 5,
          imageRequestId: `cli-video-${VIDEO_JOB_ID}`,
          prompt: "Move slowly.",
          resolution: "720",
        },
        { runner },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(runner).not.toHaveBeenCalled();
  });

  it("parses only signed-kind CLI request identifiers", () => {
    expect(parsePublicRequestId(`cli-image-${IMAGE_JOB_ID}`)).toEqual({
      kind: "image",
      jobId: IMAGE_JOB_ID,
    });
    expect(() => parsePublicRequestId("../../credentials.json")).toThrow(
      /Invalid Higgsfield CLI request ID/,
    );
  });

  it("reports an authenticated CLI without exposing the token output", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() =>
        Promise.resolve({ stdout: "higgsfield 1.1.24\n", stderr: "" }),
      )
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() =>
        Promise.resolve({ stdout: "secret-token", stderr: "" }),
      );

    const health = await getHiggsfieldCliHealth(runner);

    expect(health).toEqual({
      installed: true,
      authenticated: true,
      version: "higgsfield 1.1.24",
    });
    expect(runner).toHaveBeenNthCalledWith(
      3,
      ["auth", "token"],
      expect.objectContaining({ discardStdout: true }),
    );
  });

  it("fails safely on malformed CLI JSON", async () => {
    const runner = vi
      .fn<CliRunner>()
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result({ authenticated: true }))
      .mockImplementationOnce(() => result({ help: true }))
      .mockImplementationOnce(() => result(schema("gpt_image_2", "image")))
      .mockResolvedValueOnce({ stdout: "not-json", stderr: "" })
      .mockImplementationOnce(() => result([]));

    await expect(submitHiggsfieldImage("A portrait", { runner })).rejects.toEqual(
      new HiggsfieldError(
        "Higgsfield CLI returned an unexpected response. The job may have been submitted; check recent jobs before retrying.",
        502,
      ),
    );
  });
});
