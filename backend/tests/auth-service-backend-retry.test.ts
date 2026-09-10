import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuthStore } from "../src/auth-store.js";
import {
  AuthError,
  AuthService,
  hashSessionToken,
  verifyPassword,
} from "../src/auth-service.js";

const temporaryDirectories: string[] = [];
const PASSWORD = "correct horse battery staple";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(options: { sessionTtlMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "auth-backend-retry-"));
  temporaryDirectories.push(directory);
  let currentTime = Date.parse("2026-09-10T10:00:00.000Z");
  const store = new AuthStore(directory);
  const service = new AuthService(store, {
    clock: () => new Date(currentTime),
    sessionTtlMs: options.sessionTtlMs ?? 60_000,
    passwordHash: { cost: 16_384 },
  });
  await service.initialize();
  return {
    directory,
    service,
    store,
    advance(milliseconds: number) {
      currentTime += milliseconds;
    },
  };
}

describe("backend auth service", () => {
  it("normalizes the first user, grants admin, and persists no reusable secrets", async () => {
    const { directory, service, store } = await fixture();
    const grant = await service.bootstrapFirstAdmin({
      email: "  ADMIN@exämple.com ",
      displayName: "  Alice    Admin  ",
      password: PASSWORD,
    }, { userAgent: "😀".repeat(300) });

    expect(grant.user).toMatchObject({
      email: "admin@xn--exmple-cua.com",
      displayName: "Alice Admin",
      role: "admin",
      disabled: false,
    });
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const database = await store.read();
    expect(database.sessions[0]?.tokenHash).toBe(hashSessionToken(grant.token));
    expect(await verifyPassword(PASSWORD, database.users[0]!.passwordHash)).toBe(true);
    expect(database.audit[0]?.userAgent).toBe("😀".repeat(128));

    const serialized = await readFile(join(directory, "auth", "store.json"), "utf8");
    expect(serialized).toContain('"passwordHash": "scrypt$');
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(grant.token);
    expect(Object.keys(JSON.parse(serialized).sessions[0])).not.toContain("token");

    const restarted = new AuthService(new AuthStore(directory), {
      clock: () => new Date("2026-09-10T10:00:00.000Z"),
      passwordHash: { cost: 16_384 },
    });
    expect(await restarted.authenticateSession(grant.token)).toMatchObject({
      sessionId: grant.sessionId,
      user: { id: grant.user.id, role: "admin" },
    });
    await expect(service.bootstrapFirstAdmin({
      email: "other@example.com",
      displayName: "Other Admin",
      password: PASSWORD,
    })).rejects.toMatchObject({ code: "BOOTSTRAP_COMPLETE", status: 409 });
  });

  it("serializes competing bootstrap attempts and rejects a corrupt persisted store", async () => {
    const { directory, service } = await fixture();
    const secondService = new AuthService(new AuthStore(directory), {
      clock: () => new Date("2026-09-10T10:00:00.000Z"),
      passwordHash: { cost: 16_384 },
    });
    await secondService.initialize();
    const attempts = await Promise.allSettled([
      service.bootstrapFirstAdmin({
        email: "first@example.com",
        displayName: "First",
        password: PASSWORD,
      }),
      secondService.bootstrapFirstAdmin({
        email: "second@example.com",
        displayName: "Second",
        password: PASSWORD,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

    const path = join(directory, "auth", "store.json");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.users).toHaveLength(1);
    persisted.sessions[0].tokenHash = "plaintext-token";
    await writeFile(path, JSON.stringify(persisted), "utf8");
    await expect(new AuthStore(directory).initialize()).rejects.toMatchObject({
      code: "CORRUPT_AUTH_STORE",
    });
  });

  it("expires and revokes opaque sessions while auditing login outcomes", async () => {
    const { service, store, advance } = await fixture({ sessionTtlMs: 2_000 });
    const bootstrap = await service.bootstrapFirstAdmin({
      email: "admin@example.com",
      displayName: "Admin",
      password: PASSWORD,
    });
    await service.revokeSession(bootstrap.token, { requestId: "logout-1" });
    expect(await service.authenticateSession(bootstrap.token)).toBeNull();

    await expect(service.login({
      email: "ADMIN@example.com",
      password: "not the password",
    }, { ipAddress: "127.0.0.1" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
    const login = await service.login({ email: " ADMIN@example.com ", password: PASSWORD });
    expect(await service.authenticateSession(login.token)).toMatchObject({ user: { id: login.user.id } });
    advance(2_001);
    expect(await service.authenticateSession(login.token)).toBeNull();

    expect((await store.read()).audit.map((record) => record.action)).toEqual([
      "admin.bootstrap",
      "auth.logout",
      "auth.login_failed",
      "auth.login_succeeded",
    ]);
  });

  it("enforces live admin authority for create, update, list, and disable operations", async () => {
    const { service, store } = await fixture();
    const initialAdmin = await service.bootstrapFirstAdmin({
      email: "admin@example.com",
      displayName: "Admin",
      password: PASSWORD,
    });
    const adminActor = await service.requireSession(initialAdmin.token);
    const member = await service.createUser(adminActor, {
      email: " MEMBER@example.com ",
      displayName: " Member  User ",
      password: PASSWORD,
    });
    const memberLogin = await service.login({ email: member.email, password: PASSWORD });
    const memberActor = await service.requireSession(memberLogin.token);

    await expect(service.createUser(memberActor, {
      email: "forbidden@example.com",
      displayName: "Forbidden",
      password: PASSWORD,
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED", status: 403 });
    await expect(service.createUser(adminActor, {
      email: "member@EXAMPLE.com",
      displayName: "Duplicate",
      password: PASSWORD,
    })).rejects.toMatchObject({ code: "EMAIL_EXISTS", status: 409 });

    const secondAdmin = await service.createUser(adminActor, {
      email: "second-admin@example.com",
      displayName: "Second Admin",
      password: PASSWORD,
      role: "admin",
    });
    expect(await service.listUsers(adminActor)).toHaveLength(3);
    await service.disableUser(adminActor, member.id, { requestId: "disable-member" });
    expect(await service.authenticateSession(memberLogin.token)).toBeNull();
    await service.updateUser(adminActor, secondAdmin.id, { role: "member" });
    await expect(service.disableUser(adminActor, initialAdmin.user.id)).rejects.toMatchObject({
      code: "LAST_ADMIN",
      status: 409,
    });

    const storedMember = (await store.read()).users.find((user) => user.id === member.id)!;
    expect(storedMember.disabledAt).not.toBeNull();
    expect((await service.listAuditRecords(adminActor)).map((record) => record.action)).toContain(
      "admin.user_disabled",
    );
  });

  it("does not lose concurrent administrator mutations", async () => {
    const { service } = await fixture();
    const bootstrap = await service.bootstrapFirstAdmin({
      email: "admin@example.com",
      displayName: "Admin",
      password: PASSWORD,
    });
    const actor = await service.requireSession(bootstrap.token);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => service.createUser(actor, {
        email: `member-${index}@example.com`,
        displayName: `Member ${index}`,
        password: PASSWORD,
      })),
    );
    expect(await service.listUsers(actor)).toHaveLength(9);
  });

  it("caps active sessions and bounds retained inactive session rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-session-cap-backend-retry-"));
    temporaryDirectories.push(directory);
    const service = new AuthService(new AuthStore(directory), {
      maxActiveSessionsPerUser: 2,
      maxRetiredSessionsPerUser: 2,
      passwordHash: { cost: 16_384 },
    });
    const bootstrap = await service.bootstrapFirstAdmin({
      email: "admin@example.com",
      displayName: "Admin",
      password: PASSWORD,
    });
    const grants = [bootstrap];
    for (let index = 0; index < 5; index += 1) {
      grants.push(await service.login({ email: "admin@example.com", password: PASSWORD }));
    }

    expect(await service.authenticateSession(grants.at(-1)!.token)).not.toBeNull();
    expect(await service.authenticateSession(grants.at(-2)!.token)).not.toBeNull();
    expect(await service.authenticateSession(grants[0]!.token)).toBeNull();
    const database = await service.store.read();
    expect(database.sessions).toHaveLength(4);
    expect(database.sessions.filter((session) => session.revokedAt === null)).toHaveLength(2);
  });

  it("lets a user update their profile and rotate their own password and session", async () => {
    const { service, store } = await fixture();
    const bootstrap = await service.bootstrapFirstAdmin({
      email: "admin@example.com",
      displayName: "Admin",
      password: PASSWORD,
    });
    const actor = await service.requireSession(bootstrap.token);

    await expect(service.updateOwnProfile(actor, { displayName: "  Updated   Admin  " }))
      .resolves.toMatchObject({ displayName: "Updated Admin" });
    await expect(service.changeOwnPassword(actor, {
      currentPassword: "wrong password",
      newPassword: "a completely new passphrase",
    })).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INVALID", status: 401 });

    const replacement = await service.changeOwnPassword(actor, {
      currentPassword: PASSWORD,
      newPassword: "a completely new passphrase",
    });
    expect(await service.authenticateSession(bootstrap.token)).toBeNull();
    expect(await service.authenticateSession(replacement.token)).toMatchObject({
      user: { displayName: "Updated Admin" },
    });
    await expect(service.login({ email: "admin@example.com", password: PASSWORD }))
      .rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(service.login({
      email: "admin@example.com",
      password: "a completely new passphrase",
    })).resolves.toMatchObject({ user: { id: bootstrap.user.id } });
    expect((await store.read()).audit.map((record) => record.action)).toEqual(
      expect.arrayContaining(["account.profile_updated", "account.password_changed"]),
    );
  });

  it("uses typed backend errors for invalid inputs", async () => {
    const { service } = await fixture();
    const error = await service.bootstrapFirstAdmin({
      email: "not-an-email",
      displayName: "Admin",
      password: PASSWORD,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "INVALID_EMAIL", status: 400 });
  });
});
