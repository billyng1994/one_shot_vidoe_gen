export const GENERATION_STATUSES = [
  "queued",
  "in_progress",
  "nsfw",
  "failed",
  "completed",
  "canceled",
] as const;

export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

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

export type BackendHealth = {
  configured: boolean;
  mockMode: boolean;
  provider: string;
  storage: {
    writable: boolean;
  };
  cli: {
    installed: boolean;
    authenticated: boolean;
    version?: string;
  };
  models: {
    image: string;
    video: string;
  };
};

export type RenderResponse = {
  url: string;
  filename: string;
};
