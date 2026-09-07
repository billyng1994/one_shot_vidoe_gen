export class BackendError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 500, code = "BACKEND_ERROR") {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.code = code;
  }
}

export function publicBackendError(error: unknown) {
  if (error instanceof BackendError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    };
  }

  return {
    status: 500,
    body: {
      error: "The backend could not complete the request.",
      code: "INTERNAL_ERROR",
    },
  };
}
