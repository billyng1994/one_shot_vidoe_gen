export type ApiErrorBody = {
  code?: string;
  error?: string;
  [key: string]: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: ApiErrorBody;

  constructor(
    message: string,
    options: { status: number; code?: string; body?: ApiErrorBody; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }
}

export type ApiRequest = <ResponseBody>(
  url: string,
  init?: RequestInit,
) => Promise<ResponseBody>;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isMutation(method: string | undefined) {
  return !SAFE_METHODS.has((method ?? "GET").toUpperCase());
}

async function responseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => undefined);
  }
  const text = await response.text();
  return text || undefined;
}

function errorBody(value: unknown): ApiErrorBody | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ApiErrorBody)
    : undefined;
}

/**
 * Calls the same-origin backend proxy. Mutation requests are marked so the
 * backend can reject cross-site form posts; authenticated callers also supply
 * the in-memory CSRF token received with their session.
 */
export async function fetchApi<ResponseBody>(
  url: string,
  init: RequestInit = {},
  csrfToken?: string,
): Promise<ResponseBody> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (isMutation(init.method)) {
    headers.set("X-OneTake-Request", "1");
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError("The backend could not be reached.", {
      status: 0,
      code: "NETWORK_ERROR",
      cause,
    });
  }

  const body = await responseBody(response);
  if (!response.ok) {
    const parsed = errorBody(body);
    throw new ApiError(
      typeof parsed?.error === "string" && parsed.error
        ? parsed.error
        : `The request failed (${response.status}).`,
      {
        status: response.status,
        code: typeof parsed?.code === "string" ? parsed.code : undefined,
        body: parsed,
      },
    );
  }

  return body as ResponseBody;
}
