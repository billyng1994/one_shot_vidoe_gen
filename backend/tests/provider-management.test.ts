import { describe, expect, it, vi } from "vitest";

import {
  HIGGSFIELD_CALLBACK_PORT,
  HIGGSFIELD_LOGIN_COMMAND,
  HIGGSFIELD_TUNNEL_COMMAND,
  ProviderManagementService,
} from "../src/provider-management.js";

describe("provider management service", () => {
  it("uses a registered Higgsfield callback port for the SSH login guide", () => {
    expect(HIGGSFIELD_CALLBACK_PORT).toBe(8_765);
    expect(HIGGSFIELD_TUNNEL_COMMAND).toBe(
      "ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 8765:127.0.0.1:8765 <vm-user>@<vm-host>",
    );
    expect(HIGGSFIELD_LOGIN_COMMAND).toContain("auth login --port 8765");
    expect(HIGGSFIELD_LOGIN_COMMAND).not.toContain("18765");
  });

  it("reruns health and returns only explicitly safe provider fields", async () => {
    const secret = "provider-access-token-must-not-leak";
    const health = vi.fn(async () => ({
      configured: true,
      mockMode: false,
      provider: "Higgsfield CLI",
      storage: { writable: true, path: `/credentials/${secret}` },
      cli: {
        installed: true,
        authenticated: true,
        version: `higgsfield 1.2.3 build ${secret}`,
        token: secret,
      },
      models: { image: "GPT Image 2", video: "Seedance 2.0" },
      credentials: secret,
    }));
    const service = new ProviderManagementService({ health });

    const first = await service.status();
    const second = await service.status();

    expect(health).toHaveBeenCalledTimes(2);
    expect(first).toEqual({
      provider: "Higgsfield CLI",
      configured: true,
      mockMode: false,
      cli: { installed: true, authenticated: true, version: "1.2.3" },
      storage: { writable: true },
      models: { image: "GPT Image 2", video: "Seedance 2.0" },
      connection: {
        kind: "ssh-loopback",
        callbackPort: HIGGSFIELD_CALLBACK_PORT,
        tunnelCommand: HIGGSFIELD_TUNNEL_COMMAND,
        command: HIGGSFIELD_LOGIN_COMMAND,
        description:
          "Open one SSH tunnel without sudo and leave it running, then run the server command and complete login in your local browser. If SSH reports Address already in use, resume or stop the existing tunnel instead of starting another.",
      },
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(secret);
  });
});
