import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";

import { createBackendRuntime } from "./app.js";
import { BACKEND_ROOT, loadConfig } from "./config.js";

loadEnvironment({
  path: resolve(BACKEND_ROOT, "..", ".env.local"),
  override: false,
  quiet: true,
});

const config = loadConfig();
const runtime = createBackendRuntime(config);
await runtime.initialize();

const server = runtime.app.listen(config.port, config.host, () => {
  console.log(`Backend listening on http://${config.host}:${config.port}`);
});

function shutDown(signal: string) {
  console.log(`Received ${signal}; closing the backend.`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutDown("SIGINT"));
process.once("SIGTERM", () => shutDown("SIGTERM"));
