import express, { type NextFunction, type Request, type Response } from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearSessionCookie,
  createAuthenticationMiddleware,
  getAuthenticatedSession,
  requireAdministrator,
  requireAuthentication,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  setSessionCookie,
} from "../src/auth-http.js";
import { AuthService } from "../src/auth-service.js";
import { AuthStore } from "../src/auth-store.js";
import { publicBackendError } from "../src/errors.js";

const temporaryDirectories: string[] = [];
const PASSWORD = "correct horse battery staple";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("backend auth HTTP helpers", () => {
  it("serializes hardened cookies with configurable Secure behavior", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-http-backend-retry-"));
    temporaryDirectories.push(directory);
    const service = new AuthService(new AuthStore(directory), {
      passwordHash: { cost: 16_384 },
    });
    const grant = await service.bootstrapFirstAdmin({
      email: "admin@example.com",
      displayName: "Admin",
      password: PASSWORD,
    });

    const secure = serializeSessionCookie(grant, { secure: true, sameSite: "strict" });
    expect(secure).toContain(`one_shot_session=${grant.token}`);
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("SameSite=Strict");
    expect(secure).toContain("Secure");
    expect(secure).toContain("Path=/");
    const local = serializeSessionCookie(grant, { secure: false });
    expect(local).toContain("SameSite=Lax");
    expect(local).not.toContain("; Secure");
    expect(serializeClearedSessionCookie({ secure: false })).toContain("Max-Age=0");
  });

  it("authenticates from a cookie, exposes locals, and clears invalid cookies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-http-backend-retry-"));
    temporaryDirectories.push(directory);
    const service = new AuthService(new AuthStore(directory), {
      passwordHash: { cost: 16_384 },
    });
    const grant = await service.bootstrapFirstAdmin({
      email: "admin@example.com",
      displayName: "Admin",
      password: PASSWORD,
    });
    const app = express();
    const cookieConfig = { secure: false } as const;
    app.use(createAuthenticationMiddleware(service, cookieConfig));
    app.get("/cookie", (_request, response) => {
      setSessionCookie(response, grant, cookieConfig);
      response.status(204).end();
    });
    app.get("/clear", (_request, response) => {
      clearSessionCookie(response, cookieConfig);
      response.status(204).end();
    });
    app.get("/private", requireAuthentication, (_request, response) => {
      response.json(getAuthenticatedSession(response)?.user);
    });
    app.get("/admin", requireAdministrator, (_request, response) => {
      response.json({ admin: true });
    });
    app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      void _next;
      const result = publicBackendError(error);
      response.status(result.status).json(result.body);
    });

    const issued = await request(app).get("/cookie").expect(204);
    expect(issued.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    await request(app)
      .get("/private")
      .set("Cookie", `one_shot_session=${grant.token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ id: grant.user.id, role: "admin" }));
    await request(app)
      .get("/admin")
      .set("Cookie", `one_shot_session=${grant.token}`)
      .expect(200, { admin: true });
    await request(app).get("/private").expect(401, {
      error: "Authentication is required.",
      code: "AUTH_REQUIRED",
    });
    const malformed = await request(app)
      .get("/private")
      .set("Cookie", "one_shot_session=not-a-token")
      .expect(401);
    expect(malformed.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    expect((await request(app).get("/clear").expect(204)).headers["set-cookie"]?.[0]).toContain(
      "Max-Age=0",
    );
  });
});
