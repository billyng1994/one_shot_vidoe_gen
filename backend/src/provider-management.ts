import type { GenerationService } from "./generation-service.js";

export const HIGGSFIELD_LOGIN_COMMAND =
  "docker run --rm -it --network host --mount source=one-shot-video-studio_higgsfield-auth,target=/home/backend/.higgsfield --entrypoint /usr/local/bin/higgsfield one-shot-video-backend:local auth login --port 18765";
export const HIGGSFIELD_CALLBACK_PORT = 18_765;
export const HIGGSFIELD_TUNNEL_COMMAND =
  "ssh -L 18765:127.0.0.1:18765 <vm-user>@<vm-host>";

type ProviderHealthSource = Pick<GenerationService, "health">;

export type ProviderAdminStatus = {
  provider: "Higgsfield CLI";
  configured: boolean;
  mockMode: boolean;
  cli: {
    installed: boolean;
    authenticated: boolean;
    version?: string;
  };
  storage: {
    writable: boolean;
  };
  models: {
    image: string;
    video: string;
  };
  connection: {
    kind: "ssh-loopback";
    callbackPort: typeof HIGGSFIELD_CALLBACK_PORT;
    tunnelCommand: typeof HIGGSFIELD_TUNNEL_COMMAND;
    command: typeof HIGGSFIELD_LOGIN_COMMAND;
    description: string;
  };
};

function safeVersion(value: unknown) {
  if (value === "demo") return value;
  if (typeof value !== "string") return undefined;
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(value)?.[1];
}

/**
 * Admin-facing module around provider readiness. It deliberately builds a
 * small DTO instead of forwarding provider health objects, environment
 * variables, CLI output, credential paths, or tokens.
 */
export class ProviderManagementService {
  constructor(private readonly healthSource: ProviderHealthSource) {}

  async status(): Promise<ProviderAdminStatus> {
    const health = await this.healthSource.health();
    const version = safeVersion(health.cli.version);
    return {
      provider: "Higgsfield CLI",
      configured: health.configured === true,
      mockMode: health.mockMode === true,
      cli: {
        installed: health.cli.installed === true,
        authenticated: health.cli.authenticated === true,
        ...(version ? { version } : {}),
      },
      storage: { writable: health.storage.writable === true },
      models: {
        image: health.models.image,
        video: health.models.video,
      },
      connection: {
        kind: "ssh-loopback",
        callbackPort: HIGGSFIELD_CALLBACK_PORT,
        tunnelCommand: HIGGSFIELD_TUNNEL_COMMAND,
        command: HIGGSFIELD_LOGIN_COMMAND,
        description:
          "Open the SSH tunnel from your computer, then run the server command and complete login in your local browser.",
      },
    };
  }
}
