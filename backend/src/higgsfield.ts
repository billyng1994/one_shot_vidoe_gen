import { spawn } from "node:child_process";

export const DEFAULT_IMAGE_MODEL = "gpt_image_2";
export const DEFAULT_VIDEO_MODEL = "seedance_2_0";

export const GENERATION_STATUSES = [
  "queued",
  "in_progress",
  "nsfw",
  "failed",
  "completed",
  "canceled",
] as const;

export type GenerationStatus = (typeof GENERATION_STATUSES)[number];
export type GenerationKind = "image" | "video";

export type MediaOutput = {
  url: string;
};

export type GenerationRequest = {
  status: GenerationStatus;
  request_id: string;
  error?: string | null;
  images?: MediaOutput[];
  video?: MediaOutput;
};

type CliCommandOptions = {
  discardStdout?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CliCommandResult = {
  stdout: string;
  stderr: string;
};

export type CliRunner = (
  args: readonly string[],
  options?: CliCommandOptions,
) => Promise<CliCommandResult>;

export type VideoGenerationInput = {
  cameraFixed: boolean;
  duration: number;
  imageRequestId: string;
  prompt: string;
  resolution: "720" | "1080";
};

type CliJob = {
  aspect_ratio?: unknown;
  created_at?: unknown;
  duration?: unknown;
  id?: unknown;
  request_id?: unknown;
  job_id?: unknown;
  status?: unknown;
  state?: unknown;
  result_url?: unknown;
  output_url?: unknown;
  url?: unknown;
  error?: unknown;
  generate_audio?: unknown;
  message?: unknown;
  name?: unknown;
  result?: unknown;
  output?: unknown;
  data?: unknown;
  job?: unknown;
  job_type?: unknown;
  medias?: unknown;
  mode?: unknown;
  params?: unknown;
  prompt?: unknown;
  resolution?: unknown;
  role?: unknown;
  type?: unknown;
};

const DEFAULT_CLI_PATH = "higgsfield";
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_CLI_OUTPUT_BYTES = 2 * 1024 * 1024;
const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ID_TOKEN_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const PUBLIC_REQUEST_PATTERN =
  /^cli-(image|video)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const IMAGE_MODEL_OPTIONS: Record<string, readonly string[]> = {
  gpt_image_2: ["--quality", "high", "--resolution", "2k"],
  nano_banana: [],
  nano_banana_2: ["--resolution", "2k"],
  nano_banana_2_lite: ["--resolution", "1k", "--thinking", "HIGH"],
  nano_banana_flash: ["--resolution", "1k"],
};
const VIDEO_MODELS = new Set([DEFAULT_VIDEO_MODEL]);

export class HiggsfieldError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "HiggsfieldError";
    this.status = status;
  }
}

export function isMockMode() {
  return process.env.HIGGSFIELD_MOCK_MODE === "true";
}

function getModel(variable: string, fallback: string) {
  const model = process.env[variable]?.trim() || fallback;

  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new HiggsfieldError(`${variable} is not a valid Higgsfield CLI job type.`, 500);
  }

  return model;
}

export function getImageModel() {
  const model = getModel("HIGGSFIELD_IMAGE_MODEL", DEFAULT_IMAGE_MODEL);
  if (!(model in IMAGE_MODEL_OPTIONS)) {
    throw new HiggsfieldError(
      `Unsupported image model “${model}”. Update the app's model adapter before using it.`,
      500,
    );
  }
  return model;
}

export function getVideoModel() {
  const model = getModel("HIGGSFIELD_VIDEO_MODEL", DEFAULT_VIDEO_MODEL);
  if (!VIDEO_MODELS.has(model)) {
    throw new HiggsfieldError(
      `Unsupported video model “${model}”. This workflow currently supports Seedance 2.0.`,
      500,
    );
  }
  return model;
}

export function getModelLabel(model: string) {
  const labels: Record<string, string> = {
    gpt_image_2: "GPT Image 2",
    nano_banana: "Nano Banana",
    nano_banana_2: "Nano Banana Pro",
    nano_banana_2_lite: "Nano Banana 2 Lite",
    nano_banana_flash: "Nano Banana 2",
    seedance_2_0: "Seedance 2.0",
    seedance_2_0_mini: "Seedance 2.0 Mini",
  };

  return labels[model] ?? model;
}

function getCliPath() {
  const cliPath = process.env.HIGGSFIELD_CLI_PATH?.trim() || DEFAULT_CLI_PATH;

  if (cliPath.includes("\0")) {
    throw new HiggsfieldError("HIGGSFIELD_CLI_PATH is invalid.", 500);
  }

  return cliPath;
}

function getCliEnvironment() {
  const environment: NodeJS.ProcessEnv = {};
  const allowedKeys = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_PROXY",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "USER",
    "XDG_CONFIG_HOME",
    "all_proxy",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ];
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("HIGGSFIELD_") &&
      key !== "HIGGSFIELD_API_BASE_URL" &&
      key !== "HIGGSFIELD_CLI_PATH" &&
      key !== "HIGGSFIELD_MOCK_MODE"
    ) {
      environment[key] = value;
    }
  }
  environment.HIGGSFIELD_NO_UPDATE_CHECK = "1";

  return environment;
}

function cleanCliMessage(value: string) {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function cliFailure(stderr: string, exitCode: number | null) {
  const message = cleanCliMessage(stderr);
  const lower = message.toLowerCase();

  if (lower.includes("not authenticated") || lower.includes("session expired")) {
    return new HiggsfieldError(
      "Higgsfield CLI is not authenticated. Run `higgsfield auth login` on the host and restart the container.",
      503,
    );
  }
  if (lower.includes("unknown model") || lower.includes("no model with")) {
    return new HiggsfieldError(
      "The configured Higgsfield CLI model is unavailable. Run `higgsfield model list` and update the model setting.",
      404,
    );
  }
  if (lower.includes("credit") || lower.includes("balance")) {
    return new HiggsfieldError("The Higgsfield account does not have enough credits.", 402);
  }
  if (
    lower.includes("missing required") ||
    lower.includes("invalid") ||
    lower.includes("unsupported")
  ) {
    return new HiggsfieldError(message || "Higgsfield rejected the generation options.", 400);
  }

  return new HiggsfieldError(
    `Higgsfield CLI failed${exitCode === null ? "" : ` (exit ${exitCode})`}. Check its login, workspace, credits, and model settings.`,
    502,
  );
}

export const runHiggsfieldCli: CliRunner = (
  args,
  { discardStdout = false, signal, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {},
) =>
  new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ getCliPath(), [...args], {
      env: getCliEnvironment(),
      shell: false,
      stdio: ["ignore", discardStdout ? "ignore" : "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;
    let terminating = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();

    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    const append = (current: string, chunk: Buffer | string) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > MAX_CLI_OUTPUT_BYTES) {
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

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);

      if (error.code === "ENOENT") {
        reject(
          new HiggsfieldError(
            "Higgsfield CLI is not installed or HIGGSFIELD_CLI_PATH is incorrect.",
            503,
          ),
        );
        return;
      }
      reject(new HiggsfieldError("Higgsfield CLI could not be started.", 502));
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);

      if (signal?.aborted) {
        reject(new HiggsfieldError("The Higgsfield command was canceled.", 408));
      } else if (timedOut) {
        reject(
          new HiggsfieldError(
            "Higgsfield CLI timed out. Check the existing job before submitting it again.",
            504,
          ),
        );
      } else if (outputTooLarge) {
        reject(new HiggsfieldError("Higgsfield CLI returned too much output.", 502));
      } else if (code !== 0) {
        reject(cliFailure(stderr, code));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

function parseCliJson(stdout: string): CliJob {
  const value = JSON.parse(stdout.trim()) as unknown;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("not an object");
  }

  return value as CliJob;
}

function parseCliOutput(stdout: string) {
  try {
    return parseCliJson(stdout);
  } catch {
    throw new HiggsfieldError("Higgsfield CLI returned invalid JSON.", 502);
  }
}

function parseCreateOutput(stdout: string, model: string) {
  const createJob = (id: string) => ({ id, job_type: model }) satisfies CliJob;

  try {
    const value = JSON.parse(stdout.trim()) as unknown;

    if (typeof value === "string" && JOB_ID_PATTERN.test(value)) {
      return createJob(value);
    }
    if (Array.isArray(value) && value.length === 1) {
      const item = nestedRecord(value[0]);
      if (item) return item;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as CliJob;
    }
  } catch {
    // Fall through to the CLI's human-readable success format below.
  }

  const jobIds = [...new Set(stdout.match(JOB_ID_TOKEN_PATTERN) ?? [])];
  if (jobIds.length === 1) {
    return createJob(jobIds[0]!);
  }

  throw new HiggsfieldError(
    "Higgsfield CLI returned an unexpected response. The job may have been submitted; check recent jobs before retrying.",
    502,
  );
}

function bindCliOptions(options: readonly string[]) {
  const bound: string[] = [];

  for (let index = 0; index < options.length; index += 2) {
    bound.push(`${options[index]}=${options[index + 1]}`);
  }

  return bound;
}

function nestedRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CliJob)
    : undefined;
}

function parseCliJobList(stdout: string) {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (!Array.isArray(value)) throw new Error("not an array");
    return value.flatMap((item) => {
      const job = nestedRecord(item);
      return job ? [job] : [];
    });
  } catch {
    throw new HiggsfieldError("Higgsfield CLI returned an invalid recent-jobs list.", 502);
  }
}

function matchesModel(job: CliJob, model: string) {
  const aliases: Record<string, readonly string[]> = {
    nano_banana_2: ["nano_banana_2", "nano_banana_pro"],
  };
  const accepted = aliases[model] ?? [model];
  return typeof job.job_type === "string" && accepted.includes(job.job_type);
}

function usesSourceImage(job: CliJob, sourceJobId: string) {
  const params = nestedRecord(job.params);
  if (!Array.isArray(params?.medias)) return false;

  return params.medias.some((value) => {
    const media = nestedRecord(value);
    const data = nestedRecord(media?.data);
    return media?.role === "start_image" && data?.id === sourceJobId;
  });
}

async function recoverRecentJob(
  input: {
    kind: GenerationKind;
    model: string;
    notBefore: number;
    prompt: string;
    aspectRatio?: string;
    duration?: number;
    generateAudio?: boolean;
    mode?: string;
    resolution?: string;
    sourceJobId?: string;
  },
  runner: CliRunner,
  signal?: AbortSignal,
) {
  const result = await runner(
    [
      "--json",
      "--no-color",
      "generate",
      "list",
      input.kind === "image" ? "--image" : "--video",
      "--size",
      "20",
    ],
    { signal, timeoutMs: 20_000 },
  );
  const now = Date.now();
  const candidates = parseCliJobList(result.stdout)
    .filter((job) => {
      const params = nestedRecord(job.params);
      const createdAt =
        typeof job.created_at === "string" ? Date.parse(job.created_at) : Number.NaN;
      const resultUrl = extractResultUrl(job);
      const status = normalizeStatus(
        job.status ?? job.state,
        Boolean(resultUrl),
        Boolean(stringValue(job.error)),
      );
      return (
        matchesModel(job, input.model) &&
        params?.prompt === input.prompt &&
        (input.aspectRatio === undefined || params?.aspect_ratio === input.aspectRatio) &&
        (input.duration === undefined || params?.duration === input.duration) &&
        (input.generateAudio === undefined || params?.generate_audio === input.generateAudio) &&
        (input.mode === undefined || params?.mode === input.mode) &&
        (input.resolution === undefined || params?.resolution === input.resolution) &&
        (input.sourceJobId === undefined || usesSourceImage(job, input.sourceJobId)) &&
        (status === "queued" || status === "in_progress" || (status === "completed" && Boolean(resultUrl))) &&
        Number.isFinite(createdAt) &&
        createdAt >= input.notBefore &&
        createdAt <= now + 30_000
      );
    })
    .sort(
      (left, right) =>
        Date.parse(String(right.created_at)) - Date.parse(String(left.created_at)),
    );

  return candidates[0];
}

async function resolveCreatedJob(
  stdout: string,
  input: {
    aspectRatio?: string;
    duration?: number;
    generateAudio?: boolean;
    kind: GenerationKind;
    mode?: string;
    model: string;
    prompt: string;
    resolution?: string;
    sourceJobId?: string;
    submittedAt: number;
  },
  runner: CliRunner,
  signal?: AbortSignal,
) {
  try {
    const job = parseCreateOutput(stdout, input.model);
    extractJobId(job);
    return job;
  } catch (parseError) {
    try {
      const recovered = await recoverRecentJob(
        { ...input, notBefore: input.submittedAt - 30_000 },
        runner,
        signal,
      );
      if (recovered) return recovered;
    } catch {
      // Preserve the submission-protocol error so callers know not to retry blindly.
    }
    throw parseError;
  }
}

function stringValue(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function extractJobId(job: CliJob) {
  const nested = nestedRecord(job.job) ?? nestedRecord(job.data);
  const id = stringValue(
    job.id,
    job.job_id,
    job.request_id,
    nested?.id,
    nested?.job_id,
    nested?.request_id,
  );

  if (!id || !JOB_ID_PATTERN.test(id)) {
    throw new HiggsfieldError("Higgsfield CLI did not return a valid job ID.", 502);
  }

  return id;
}

function extractResultUrl(job: CliJob) {
  const result = nestedRecord(job.result);
  const output = nestedRecord(job.output);
  const data = nestedRecord(job.data);
  const url = stringValue(
    job.result_url,
    job.output_url,
    result?.url,
    result?.result_url,
    output?.url,
    output?.result_url,
    data?.result_url,
    data?.output_url,
    job.url,
  );

  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStatus(value: unknown, hasResult: boolean, hasError = false): GenerationStatus {
  if (typeof value !== "string") {
    return hasResult ? "completed" : hasError ? "failed" : "queued";
  }

  const status = value.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["created", "pending", "submitted", "queued"].includes(status)) return "queued";
  if (
    [
      "running",
      "processing",
      "in_progress",
      "waiting",
      "script",
      "visuals",
      "flow",
      "vision",
      "dna",
    ].includes(status)
  ) {
    return "in_progress";
  }
  if (["complete", "completed", "done", "success", "succeeded"].includes(status)) {
    return "completed";
  }
  if (["nsfw", "moderated", "safety_rejected", "ip_detected"].includes(status)) return "nsfw";
  if (["cancelled", "canceled"].includes(status)) return "canceled";
  if (["failed", "failure", "error"].includes(status)) return "failed";
  return hasResult ? "completed" : hasError ? "failed" : "in_progress";
}

function publicRequestId(kind: GenerationKind, jobId: string) {
  return `cli-${kind}-${jobId}`;
}

export function parsePublicRequestId(requestId: string) {
  const match = PUBLIC_REQUEST_PATTERN.exec(requestId);

  if (!match) {
    throw new HiggsfieldError("Invalid Higgsfield CLI request ID.", 400);
  }

  return {
    kind: match[1]!.toLowerCase() as GenerationKind,
    jobId: match[2]!,
  };
}

function normalizeJob(job: CliJob, kind: GenerationKind, knownJobId?: string) {
  const jobId = knownJobId ?? extractJobId(job);
  const resultUrl = extractResultUrl(job);
  const explicitError = stringValue(job.error);
  const status = normalizeStatus(
    job.status ?? job.state,
    Boolean(resultUrl),
    Boolean(explicitError),
  );
  const error = explicitError ?? (
    status === "failed" || status === "canceled" ? stringValue(job.message) : undefined
  );
  const normalized: GenerationRequest = {
    status,
    request_id: publicRequestId(kind, jobId),
    ...(error ? { error } : undefined),
  };

  if (resultUrl && kind === "image") normalized.images = [{ url: resultUrl }];
  if (resultUrl && kind === "video") normalized.video = { url: resultUrl };

  if (status === "completed" && !resultUrl) {
    normalized.status = "failed";
    normalized.error = "Higgsfield completed without returning a secure result URL.";
  }

  return normalized;
}

async function requireCliAuthentication(runner: CliRunner, signal?: AbortSignal) {
  await runner(["--help"], { signal, timeoutMs: 10_000 });
  await runner(["auth", "--help"], { signal, timeoutMs: 10_000 });
  await runner(["auth", "token"], {
    discardStdout: true,
    signal,
    timeoutMs: 15_000,
  });
}

async function preflightModel(model: string, runner: CliRunner, signal?: AbortSignal) {
  await requireCliAuthentication(runner, signal);
  await runner(["generate", "create", "--help"], { signal, timeoutMs: 10_000 });
  const result = await runner(["--json", "--no-color", "model", "get", model], {
    signal,
    timeoutMs: 20_000,
  });
  const schema = parseCliOutput(result.stdout);
  const expectedType: GenerationKind = model === DEFAULT_VIDEO_MODEL ? "video" : "image";
  const parameterNames = new Set(
    Array.isArray(schema.params)
      ? schema.params.flatMap((parameter) => {
          const record = nestedRecord(parameter);
          return typeof record?.name === "string" ? [record.name] : [];
        })
      : [],
  );
  const requiredParameters =
    expectedType === "video"
      ? ["prompt", "start_image", "duration", "resolution", "aspect_ratio", "mode", "generate_audio"]
      : [
          "prompt",
          "aspect_ratio",
          ...IMAGE_MODEL_OPTIONS[model]!
            .filter((_, index) => index % 2 === 0)
            .map((flag) => flag.replace(/^--/, "").replaceAll("-", "_")),
        ];

  if (
    schema.job_type !== model ||
    schema.type !== expectedType ||
    requiredParameters.some((parameter) => !parameterNames.has(parameter))
  ) {
    throw new HiggsfieldError(
      `The installed Higgsfield CLI schema for “${model}” does not match this app.`,
      503,
    );
  }
}

export async function getHiggsfieldCliHealth(runner: CliRunner = runHiggsfieldCli) {
  if (isMockMode()) {
    return { installed: true, authenticated: true, version: "demo" };
  }

  try {
    const version = await runner(["version"], { timeoutMs: 10_000 });
    await runner(["auth", "--help"], { timeoutMs: 10_000 });
    await runner(["auth", "token"], {
      discardStdout: true,
      timeoutMs: 15_000,
    });
    return {
      installed: true,
      authenticated: true,
      version: cleanCliMessage(version.stdout),
    };
  } catch (error) {
    const installed =
      !(error instanceof HiggsfieldError) ||
      !error.message.includes("not installed");
    return {
      installed,
      authenticated: false,
      version: undefined,
    };
  }
}

export async function findRecentHiggsfieldImage(
  prompt: string,
  options: { runner?: CliRunner; signal?: AbortSignal } = {},
) {
  const runner = options.runner ?? runHiggsfieldCli;
  const model = getImageModel();
  await requireCliAuthentication(runner, options.signal);
  const job = await recoverRecentJob(
    {
      aspectRatio: "1:1",
      kind: "image",
      model,
      notBefore: Date.now() - 30 * 60_000,
      prompt,
    },
    runner,
    options.signal,
  );

  return job ? normalizeJob(job, "image") : undefined;
}

function effectiveVideoPrompt(input: VideoGenerationInput) {
  return input.cameraFixed
    ? `${input.prompt}\nCamera remains locked off and motionless for the entire clip.`
    : input.prompt;
}

export async function findRecentHiggsfieldVideo(
  input: VideoGenerationInput,
  options: { runner?: CliRunner; signal?: AbortSignal } = {},
) {
  const runner = options.runner ?? runHiggsfieldCli;
  const model = getVideoModel();
  const source = parsePublicRequestId(input.imageRequestId);
  if (source.kind !== "image") {
    throw new HiggsfieldError("The first-frame job must be an image generation.", 400);
  }

  await requireCliAuthentication(runner, options.signal);
  const job = await recoverRecentJob(
    {
      aspectRatio: "1:1",
      duration: input.duration,
      generateAudio: false,
      kind: "video",
      mode: "std",
      model,
      notBefore: Date.now() - 30 * 60_000,
      prompt: effectiveVideoPrompt(input),
      resolution: `${input.resolution}p`,
      sourceJobId: source.jobId,
    },
    runner,
    options.signal,
  );

  return job ? normalizeJob(job, "video") : undefined;
}

export async function submitHiggsfieldImage(
  prompt: string,
  options: { runner?: CliRunner; signal?: AbortSignal } = {},
) {
  const runner = options.runner ?? runHiggsfieldCli;
  const model = getImageModel();
  await preflightModel(model, runner, options.signal);

  const modelOptions = IMAGE_MODEL_OPTIONS[model]!;
  const submittedAt = Date.now();

  const result = await runner(
    [
      "--json",
      "--no-color",
      "generate",
      "create",
      model,
      `--prompt=${prompt}`,
      "--aspect_ratio=1:1",
      ...bindCliOptions(modelOptions),
    ],
    { signal: options.signal, timeoutMs: 60_000 },
  );

  const job = await resolveCreatedJob(
    result.stdout,
    { aspectRatio: "1:1", kind: "image", model, prompt, submittedAt },
    runner,
    options.signal,
  );
  return normalizeJob(job, "image");
}

async function getRawCliJob(jobId: string, runner: CliRunner, signal?: AbortSignal) {
  const result = await runner(
    ["--json", "--no-color", "generate", "get", jobId],
    { signal, timeoutMs: 20_000 },
  );
  return parseCliOutput(result.stdout);
}

export async function submitHiggsfieldVideo(
  input: VideoGenerationInput,
  options: { runner?: CliRunner; signal?: AbortSignal } = {},
) {
  const runner = options.runner ?? runHiggsfieldCli;
  const model = getVideoModel();
  const source = parsePublicRequestId(input.imageRequestId);

  if (source.kind !== "image") {
    throw new HiggsfieldError("The first-frame job must be an image generation.", 400);
  }

  await preflightModel(model, runner, options.signal);
  const sourceJob = normalizeJob(
    await getRawCliJob(source.jobId, runner, options.signal),
    "image",
    source.jobId,
  );
  if (sourceJob.status !== "completed" || !sourceJob.images?.[0]?.url) {
    throw new HiggsfieldError("The first-frame image job is not completed.", 409);
  }

  const prompt = effectiveVideoPrompt(input);
  const submittedAt = Date.now();
  const result = await runner(
    [
      "--json",
      "--no-color",
      "generate",
      "create",
      model,
      `--prompt=${prompt}`,
      `--start-image=${source.jobId}`,
      `--duration=${input.duration}`,
      `--resolution=${input.resolution}p`,
      "--aspect_ratio=1:1",
      "--mode=std",
      "--generate_audio=false",
    ],
    { signal: options.signal, timeoutMs: 60_000 },
  );

  const job = await resolveCreatedJob(
    result.stdout,
    {
      aspectRatio: "1:1",
      duration: input.duration,
      generateAudio: false,
      kind: "video",
      mode: "std",
      model,
      prompt,
      resolution: `${input.resolution}p`,
      sourceJobId: source.jobId,
      submittedAt,
    },
    runner,
    options.signal,
  );
  return normalizeJob(job, "video");
}

export async function getHiggsfieldGeneration(
  requestId: string,
  options: { runner?: CliRunner; signal?: AbortSignal } = {},
) {
  const runner = options.runner ?? runHiggsfieldCli;
  const request = parsePublicRequestId(requestId);
  await requireCliAuthentication(runner, options.signal);
  const job = await getRawCliJob(request.jobId, runner, options.signal);
  return normalizeJob(job, request.kind, request.jobId);
}

export function publicError(error: unknown) {
  if (error instanceof HiggsfieldError) {
    return {
      status: error.status,
      body: { error: error.message },
    };
  }

  return {
    status: 500,
    body: { error: "Something went wrong while running Higgsfield CLI." },
  };
}
