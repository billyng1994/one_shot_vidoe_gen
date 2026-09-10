import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { BackendError } from "./errors.js";

export const AUTH_ROLES = ["admin", "member"] as const;

export type AuthRole = (typeof AUTH_ROLES)[number];

export type StoredAuthUser = {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: AuthRole;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredAuthSession = {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
};

export const AUDIT_ACTIONS = [
  "admin.bootstrap",
  "auth.login_succeeded",
  "auth.login_failed",
  "auth.logout",
  "account.profile_updated",
  "account.password_changed",
  "admin.user_created",
  "admin.user_updated",
  "admin.user_disabled",
  "admin.user_enabled",
  "admin.sessions_revoked",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditDetailValue = string | number | boolean | null;

export type StoredAuditRecord = {
  id: string;
  action: AuditAction;
  actorUserId: string | null;
  targetUserId: string | null;
  sessionId: string | null;
  occurredAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  details: Record<string, AuditDetailValue>;
};

export type AuthDatabase = {
  version: 1;
  users: StoredAuthUser[];
  sessions: StoredAuthSession[];
  audit: StoredAuditRecord[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/;
const PASSWORD_HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;
const ROLE_SET = new Set<string>(AUTH_ROLES);
const AUDIT_ACTION_SET = new Set<string>(AUDIT_ACTIONS);
const STORE_LOCKS = new Map<string, Promise<void>>();

function databaseError(message: string): never {
  throw new BackendError(message, 500, "CORRUPT_AUTH_STORE");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, field: string, maximumLength = 1_024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumLength
  ) {
    databaseError(`The auth store has an invalid ${field}.`);
  }
  return value;
}

function nullableString(value: unknown, field: string, maximumLength = 1_024): string | null {
  if (value === null) return null;
  return requiredString(value, field, maximumLength);
}

function uuid(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 64);
  if (!UUID_PATTERN.test(parsed)) databaseError(`The auth store has an invalid ${field}.`);
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 64);
  if (!Number.isFinite(Date.parse(parsed))) {
    databaseError(`The auth store has an invalid ${field}.`);
  }
  return parsed;
}

function parseUser(value: unknown): StoredAuthUser {
  const parsed = objectRecord(value);
  if (!parsed) databaseError("The auth store contains an invalid user.");

  const role = requiredString(parsed.role, "user role", 16);
  if (!ROLE_SET.has(role)) databaseError("The auth store has an invalid user role.");
  const passwordHash = requiredString(parsed.passwordHash, "password hash", 512);
  const passwordParts = PASSWORD_HASH_PATTERN.exec(passwordHash);
  const cost = Number(passwordParts?.[1]);
  const blockSize = Number(passwordParts?.[2]);
  const parallelization = Number(passwordParts?.[3]);
  const saltLength = passwordParts?.[4]
    ? Buffer.from(passwordParts[4], "base64url").length
    : 0;
  const keyLength = passwordParts?.[5]
    ? Buffer.from(passwordParts[5], "base64url").length
    : 0;
  if (
    !passwordParts ||
    !Number.isSafeInteger(cost) ||
    cost < 16_384 ||
    cost > 262_144 ||
    (cost & (cost - 1)) !== 0 ||
    !Number.isSafeInteger(blockSize) ||
    blockSize < 1 ||
    blockSize > 32 ||
    !Number.isSafeInteger(parallelization) ||
    parallelization < 1 ||
    parallelization > 16 ||
    saltLength < 16 ||
    saltLength > 64 ||
    keyLength < 32 ||
    keyLength > 128
  ) {
    databaseError("The auth store has an invalid password hash.");
  }

  const createdAt = timestamp(parsed.createdAt, "user creation time");
  const updatedAt = timestamp(parsed.updatedAt, "user update time");
  const disabledAt = parsed.disabledAt === null
    ? null
    : timestamp(parsed.disabledAt, "user disabled time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    databaseError("The auth store has a user update before its creation.");
  }
  if (disabledAt && Date.parse(disabledAt) < Date.parse(createdAt)) {
    databaseError("The auth store has a user disable time before its creation.");
  }

  return {
    id: uuid(parsed.id, "user ID"),
    email: requiredString(parsed.email, "user email", 254),
    displayName: requiredString(parsed.displayName, "display name", 320),
    passwordHash,
    role: role as AuthRole,
    disabledAt,
    createdAt,
    updatedAt,
  };
}

function parseSession(value: unknown): StoredAuthSession {
  const parsed = objectRecord(value);
  if (!parsed) databaseError("The auth store contains an invalid session.");
  const tokenHash = requiredString(parsed.tokenHash, "session token hash", 64);
  if (!SHA_256_PATTERN.test(tokenHash)) {
    databaseError("The auth store has an invalid session token hash.");
  }

  const createdAt = timestamp(parsed.createdAt, "session creation time");
  const expiresAt = timestamp(parsed.expiresAt, "session expiry time");
  const revokedAt = parsed.revokedAt === null
    ? null
    : timestamp(parsed.revokedAt, "session revocation time");
  const revocationReason = nullableString(parsed.revocationReason, "session revocation reason", 128);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    databaseError("The auth store has a session that does not expire after creation.");
  }
  if (revokedAt && Date.parse(revokedAt) < Date.parse(createdAt)) {
    databaseError("The auth store has a session revocation before its creation.");
  }
  if ((revokedAt === null) !== (revocationReason === null)) {
    databaseError("The auth store has inconsistent session revocation data.");
  }

  return {
    id: uuid(parsed.id, "session ID"),
    tokenHash,
    userId: uuid(parsed.userId, "session user ID"),
    createdAt,
    expiresAt,
    revokedAt,
    revocationReason,
  };
}

function parseDetails(value: unknown): Record<string, AuditDetailValue> {
  const parsed = objectRecord(value);
  if (!parsed) databaseError("The auth store contains invalid audit details.");
  const details: Record<string, AuditDetailValue> = {};
  const entries = Object.entries(parsed);
  if (entries.length > 24) databaseError("The auth store contains too many audit details.");
  for (const [key, detail] of entries) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key)) {
      databaseError("The auth store contains an invalid audit detail key.");
    }
    if (
      detail !== null &&
      typeof detail !== "string" &&
      typeof detail !== "number" &&
      typeof detail !== "boolean"
    ) {
      databaseError("The auth store contains an invalid audit detail value.");
    }
    if (typeof detail === "string" && detail.length > 1_024) {
      databaseError("The auth store contains an oversized audit detail value.");
    }
    if (typeof detail === "number" && !Number.isFinite(detail)) {
      databaseError("The auth store contains a non-finite audit detail value.");
    }
    details[key] = detail;
  }
  return details;
}

function parseAuditRecord(value: unknown): StoredAuditRecord {
  const parsed = objectRecord(value);
  if (!parsed) databaseError("The auth store contains an invalid audit record.");
  const action = requiredString(parsed.action, "audit action", 64);
  if (!AUDIT_ACTION_SET.has(action)) databaseError("The auth store has an invalid audit action.");

  return {
    id: uuid(parsed.id, "audit record ID"),
    action: action as AuditAction,
    actorUserId: parsed.actorUserId === null ? null : uuid(parsed.actorUserId, "audit actor ID"),
    targetUserId: parsed.targetUserId === null ? null : uuid(parsed.targetUserId, "audit target ID"),
    sessionId: parsed.sessionId === null ? null : uuid(parsed.sessionId, "audit session ID"),
    occurredAt: timestamp(parsed.occurredAt, "audit time"),
    ipAddress: nullableString(parsed.ipAddress, "audit IP address", 128),
    userAgent: nullableString(parsed.userAgent, "audit user agent", 512),
    requestId: nullableString(parsed.requestId, "audit request ID", 128),
    details: parseDetails(parsed.details),
  };
}

function assertUnique(values: string[], field: string) {
  if (new Set(values).size !== values.length) {
    databaseError(`The auth store contains a duplicate ${field}.`);
  }
}

export function parseAuthDatabase(value: unknown): AuthDatabase {
  const parsed = objectRecord(value);
  if (!parsed || parsed.version !== 1) {
    databaseError("The auth store version is invalid.");
  }
  if (!Array.isArray(parsed.users) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.audit)) {
    databaseError("The auth store is incomplete.");
  }

  const users = parsed.users.map(parseUser);
  const sessions = parsed.sessions.map(parseSession);
  const audit = parsed.audit.map(parseAuditRecord);
  assertUnique(users.map((user) => user.id), "user ID");
  assertUnique(users.map((user) => user.email), "user email");
  assertUnique(sessions.map((session) => session.id), "session ID");
  assertUnique(sessions.map((session) => session.tokenHash), "session token hash");
  assertUnique(audit.map((record) => record.id), "audit record ID");

  const userIds = new Set(users.map((user) => user.id));
  for (const session of sessions) {
    if (!userIds.has(session.userId)) {
      databaseError("The auth store contains a session for an unknown user.");
    }
  }
  for (const record of audit) {
    if (record.actorUserId && !userIds.has(record.actorUserId)) {
      databaseError("The auth store contains an audit record with an unknown actor.");
    }
    if (record.targetUserId && !userIds.has(record.targetUserId)) {
      databaseError("The auth store contains an audit record with an unknown target.");
    }
    // Audit records intentionally outlive expired session rows.
  }

  return { version: 1, users, sessions, audit };
}

function emptyDatabase(): AuthDatabase {
  return { version: 1, users: [], sessions: [], audit: [] };
}

/**
 * A one-process JSON store. Every mutation is applied to an isolated draft,
 * validated, fsynced to a same-directory temporary file, and atomically renamed.
 */
export class AuthStore {
  readonly directory: string;
  readonly path: string;

  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory, "auth");
    this.path = join(this.directory, "store.json");
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
    });
  }

  private async load(): Promise<AuthDatabase> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      return parseAuthDatabase(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof BackendError) throw error;
        throw new BackendError("The auth store could not be read.", 500, "CORRUPT_AUTH_STORE");
      }
      const initial = emptyDatabase();
      await this.atomicWrite(initial);
      return initial;
    }
  }

  private async exclusive<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const previous = STORE_LOCKS.get(this.path) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    STORE_LOCKS.set(this.path, settled);
    try {
      return await current;
    } finally {
      if (STORE_LOCKS.get(this.path) === settled) STORE_LOCKS.delete(this.path);
    }
  }

  private async atomicWrite(database: AuthDatabase): Promise<AuthDatabase> {
    const validated = parseAuthDatabase(database);
    const temporary = join(this.directory, `.store.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);

      // Windows does not support opening directories. POSIX directory fsync errors
      // are surfaced because they mean crash durability was not established.
      if (process.platform !== "win32") {
        const directoryHandle = await open(this.directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
      return validated;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async read(): Promise<AuthDatabase> {
    return this.exclusive(async () => structuredClone(await this.load()));
  }

  async mutate<Result>(
    mutation: (database: AuthDatabase) => Result | Promise<Result>,
  ): Promise<Result> {
    return this.exclusive(async () => {
      const draft = structuredClone(await this.load());
      const result = await mutation(draft);
      await this.atomicWrite(draft);
      return result;
    });
  }
}
