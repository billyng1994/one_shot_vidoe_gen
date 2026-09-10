import { describe, expect, it, vi } from "vitest";

import {
  HIGGSFIELD_CALLBACK_PORT,
  HIGGSFIELD_LOGIN_COMMAND,
  HIGGSFIELD_TUNNEL_COMMAND,
  ProviderManagementService,
} from "../src/provider-management.js";

describe("provider management service", () => {
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
          "Open the SSH tunnel from your computer, then run the server command and complete login in your local browser.",
      },
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(secret);
  });
});
