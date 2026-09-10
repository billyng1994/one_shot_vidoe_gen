import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { domainToASCII } from "node:url";

import {
  AUTH_ROLES,
  type AuditAction,
  type AuditDetailValue,
  type AuthDatabase,
  type AuthRole,
  AuthStore,
  type StoredAuditRecord,
  type StoredAuthSession,
  type StoredAuthUser,
} from "./auth-store.js";
import { BackendError } from "./errors.js";

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const PASSWORD_MINIMUM_LENGTH = 12;
export const PASSWORD_MAXIMUM_BYTES = 1_024;
export const DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER = 20;
export const DEFAULT_MAX_RETIRED_SESSIONS_PER_USER = 100;
export const DEFAULT_RETIRED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: AuthRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AuthenticatedSession = {
  sessionId: string;
  expiresAt: string;
  user: AuthUser;
};

export type SessionGrant = AuthenticatedSession & {
  /** Returned once to the caller. Only its SHA-256 digest is persisted. */
  token: string;
};

export type AuditContext = {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
};

export type CreateUserInput = Record<string, unknown> & {
  email?: unknown;
  displayName?: unknown;
  password?: unknown;
  role?: unknown;
};

export type LoginInput = Record<string, unknown> & {
  email?: unknown;
  password?: unknown;
};

export type UpdateUserInput = Record<string, unknown> & {
  email?: unknown;
  displayName?: unknown;
  password?: unknown;
  role?: unknown;
  disabled?: unknown;
};

export type UpdateOwnProfileInput = Record<string, unknown> & {
  displayName?: unknown;
};

export type ChangeOwnPasswordInput = Record<string, unknown> & {
  currentPassword?: unknown;
  newPassword?: unknown;
};

export type PasswordHashOptions = {
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
  saltLength: number;
};

export type AuthServiceOptions = {
  clock?: () => Date;
  sessionTtlMs?: number;
  maxAuditRecords?: number;
  maxActiveSessionsPerUser?: number;
  maxRetiredSessionsPerUser?: number;
  retiredSessionRetentionMs?: number;
  passwordHash?: Partial<PasswordHashOptions>;
};

const DEFAULT_PASSWORD_HASH_OPTIONS: PasswordHashOptions = {
  cost: 131_072,
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
  saltLength: 16,
};
const ROLE_SET = new Set<string>(AUTH_ROLES);
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

export class AuthError extends BackendError {
  constructor(message: string, status: number, code: string) {
    super(message, status, code);
    this.name = "AuthError";
  }
}

function invalidInput(message: string, code: string): never {
  throw new AuthError(message, 400, code);
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") invalidInput("A valid email address is required.", "INVALID_EMAIL");
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (normalized.length === 0 || /[\p{Cc}\p{Cf}\p{Z}]/u.test(normalized)) {
    invalidInput("A valid email address is required.", "INVALID_EMAIL");
  }

  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator !== normalized.indexOf("@")) {
    invalidInput("A valid email address is required.", "INVALID_EMAIL");
  }
  const local = normalized.slice(0, separator);
  const rawDomain = normalized.slice(separator + 1);
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (
    Buffer.byteLength(local, "utf8") > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[^\s@"(),:;<>\[\]\\]+$/u.test(local) ||
    domain.length === 0 ||
    domain.length > 253 ||
    !domain.includes(".")
  ) {
    invalidInput("A valid email address is required.", "INVALID_EMAIL");
  }
  const labels = domain.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    invalidInput("A valid email address is required.", "INVALID_EMAIL");
  }

  const email = `${local}@${domain}`;
  if (Buffer.byteLength(email, "utf8") > 254) {
    invalidInput("A valid email address is required.", "INVALID_EMAIL");
  }
  return email;
}

export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") invalidInput("A display name is required.", "INVALID_DISPLAY_NAME");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    invalidInput("The display name must be between 1 and 80 visible characters.", "INVALID_DISPLAY_NAME");
  }
  return normalized;
}

function validateNewPassword(value: unknown): string {
  if (typeof value !== "string") {
    invalidInput(`The password must be at least ${PASSWORD_MINIMUM_LENGTH} characters.`, "INVALID_PASSWORD");
  }
  const length = Array.from(value).length;
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    length < PASSWORD_MINIMUM_LENGTH ||
    bytes > PASSWORD_MAXIMUM_BYTES ||
    !/\S/u.test(value)
  ) {
    invalidInput(
      `The password must be at least ${PASSWORD_MINIMUM_LENGTH} characters and at most ${PASSWORD_MAXIMUM_BYTES} bytes.`,
      "INVALID_PASSWORD",
    );
  }
  return value;
}

function validateHashOptions(overrides: Partial<PasswordHashOptions> = {}): PasswordHashOptions {
  const options = { ...DEFAULT_PASSWORD_HASH_OPTIONS, ...overrides };
  if (
    !Number.isSafeInteger(options.cost) ||
    options.cost < 16_384 ||
    options.cost > 262_144 ||
    (options.cost & (options.cost - 1)) !== 0 ||
    !Number.isSafeInteger(options.blockSize) ||
    options.blockSize < 1 ||
    options.blockSize > 32 ||
    !Number.isSafeInteger(options.parallelization) ||
    options.parallelization < 1 ||
    options.parallelization > 16 ||
    !Number.isSafeInteger(options.keyLength) ||
    options.keyLength < 32 ||
    options.keyLength > 128 ||
    !Number.isSafeInteger(options.saltLength) ||
    options.saltLength < 16 ||
    options.saltLength > 64
  ) {
    throw new AuthError("The password hashing configuration is invalid.", 500, "INVALID_AUTH_CONFIG");
  }
  return options;
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: number,
  blockSize: number,
  parallelization: number,
): Promise<Buffer> {
  const maxmem = Math.max(32 * 1024 * 1024, 128 * cost * blockSize + 2 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      keyLength,
      { N: cost, r: blockSize, p: parallelization, maxmem },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(
  passwordValue: unknown,
  overrides: Partial<PasswordHashOptions> = {},
): Promise<string> {
  const password = validateNewPassword(passwordValue);
  const options = validateHashOptions(overrides);
  const salt = randomBytes(options.saltLength);
  const derivedKey = await deriveKey(
    password,
    salt,
    options.keyLength,
    options.cost,
    options.blockSize,
    options.parallelization,
  );
  return [
    "scrypt",
    String(options.cost),
    String(options.blockSize),
    String(options.parallelization),
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

type ParsedPasswordHash = {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  expected: Buffer;
};

function parsePasswordHash(encoded: string): ParsedPasswordHash | undefined {
  const [algorithm, costText, blockSizeText, parallelizationText, saltText, expectedText, extra] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !costText ||
    !blockSizeText ||
    !parallelizationText ||
    !saltText ||
    !expectedText ||
    extra !== undefined
  ) {
    return undefined;
  }
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltText, "base64url");
    expected = Buffer.from(expectedText, "base64url");
  } catch {
    return undefined;
  }
  try {
    validateHashOptions({
      cost,
      blockSize,
      parallelization,
      keyLength: expected.length,
      saltLength: salt.length,
    });
  } catch {
    return undefined;
  }
  return { cost, blockSize, parallelization, salt, expected };
}

export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  const candidate = typeof password === "string" && Buffer.byteLength(password, "utf8") <= PASSWORD_MAXIMUM_BYTES
    ? password
    : "";
  const actual = await deriveKey(
    candidate,
    parsed.salt,
    parsed.expected.length,
    parsed.cost,
    parsed.blockSize,
    parsed.parallelization,
  );
  return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && SESSION_TOKEN_PATTERN.test(value);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function publicUser(user: StoredAuthUser): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabledAt !== null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function normalizedRole(value: unknown, fallback?: AuthRole): AuthRole {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== "string" || !ROLE_SET.has(value)) {
    invalidInput("The user role must be admin or member.", "INVALID_USER_ROLE");
  }
  return value as AuthRole;
}

function normalizedUserId(value: unknown): string {
  if (typeof value !== "string" || !USER_ID_PATTERN.test(value)) {
    invalidInput("A valid user ID is required.", "INVALID_USER_ID");
  }
  return value;
}

function cleanContextValue(value: string | undefined, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  if (!cleaned) return null;
  let result = "";
  let bytes = 0;
  for (const character of cleaned) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumLength) break;
    result += character;
    bytes += characterBytes;
  }
  return result || null;
}

function emailFingerprint(value: unknown): string {
  const candidate = typeof value === "string"
    ? value.normalize("NFKC").trim().toLowerCase().slice(0, 1_024)
    : typeof value;
  return createHash("sha256").update(candidate, "utf8").digest("hex");
}

type AppendAuditInput = {
  action: AuditAction;
  actorUserId?: string | null;
  targetUserId?: string | null;
  sessionId?: string | null;
  details?: Record<string, AuditDetailValue>;
};

function appendAudit(
  database: AuthDatabase,
  input: AppendAuditInput,
  context: AuditContext,
  occurredAt: string,
  maximumRecords: number,
): StoredAuditRecord {
  const record: StoredAuditRecord = {
    id: randomUUID(),
    action: input.action,
    actorUserId: input.actorUserId ?? null,
    targetUserId: input.targetUserId ?? null,
    sessionId: input.sessionId ?? null,
    occurredAt,
    ipAddress: cleanContextValue(context.ipAddress, 128),
    userAgent: cleanContextValue(context.userAgent, 512),
    requestId: cleanContextValue(context.requestId, 128),
    details: input.details ?? {},
  };
  if (input.action === "auth.login_failed") {
    const failureLimit = Math.max(20, Math.floor(maximumRecords / 4));
    const failureIndexes = database.audit
      .map((candidate, index) => candidate.action === "auth.login_failed" ? index : -1)
      .filter((index) => index >= 0);
    if (failureIndexes.length >= failureLimit) {
      database.audit.splice(failureIndexes[0]!, 1);
    } else if (database.audit.length >= maximumRecords) {
      // An unauthenticated caller must not evict privileged audit history.
      return record;
    }
  }
  database.audit.push(record);
  if (database.audit.length > maximumRecords) {
    const failedLoginIndex = database.audit.findIndex(
      (candidate) => candidate.action === "auth.login_failed",
    );
    database.audit.splice(failedLoginIndex >= 0 ? failedLoginIndex : 0, 1);
  }
  return record;
}

function activeSession(database: AuthDatabase, actor: AuthenticatedSession, now: number) {
  const session = database.sessions.find((candidate) => candidate.id === actor.sessionId);
  if (
    !session ||
    session.userId !== actor.user.id ||
    session.revokedAt !== null ||
    Date.parse(session.expiresAt) <= now
  ) {
    throw new AuthError("Authentication is required.", 401, "AUTH_REQUIRED");
  }
  const user = database.users.find((candidate) => candidate.id === session.userId);
  if (!user || user.disabledAt !== null) {
    throw new AuthError("Authentication is required.", 401, "AUTH_REQUIRED");
  }
  return { session, user };
}

function activeAdmin(database: AuthDatabase, actor: AuthenticatedSession, now: number) {
  const authenticated = activeSession(database, actor, now);
  if (authenticated.user.role !== "admin") {
    throw new AuthError("Administrator access is required.", 403, "ADMIN_REQUIRED");
  }
  return authenticated;
}

function issueSession(
  database: AuthDatabase,
  user: StoredAuthUser,
  now: Date,
  sessionTtlMs: number,
  maximumActiveSessions: number,
): SessionGrant {
  const activeSessions = database.sessions
    .filter((session) => (
      session.userId === user.id &&
      session.revokedAt === null &&
      Date.parse(session.expiresAt) > now.getTime()
    ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const sessionsToRevoke = Math.max(0, activeSessions.length - maximumActiveSessions + 1);
  for (const session of activeSessions.slice(0, sessionsToRevoke)) {
    session.revokedAt = now.toISOString();
    session.revocationReason = "session_limit";
  }

  let token = "";
  let tokenHash = "";
  do {
    token = randomBytes(32).toString("base64url");
    tokenHash = hashSessionToken(token);
  } while (database.sessions.some((session) => session.tokenHash === tokenHash));

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + sessionTtlMs).toISOString();
  const session: StoredAuthSession = {
    id: randomUUID(),
    tokenHash,
    userId: user.id,
    createdAt,
    expiresAt,
    revokedAt: null,
    revocationReason: null,
  };
  database.sessions.push(session);
  return {
    token,
    sessionId: session.id,
    expiresAt,
    user: publicUser(user),
  };
}

function pruneInactiveSessions(
  database: AuthDatabase,
  now: number,
  retentionMs: number,
  maximumRetiredSessionsPerUser: number,
): void {
  const retainedIds = new Set<string>();
  for (const user of database.users) {
    const userSessions = database.sessions.filter((session) => session.userId === user.id);
    const active = userSessions.filter(
      (session) => session.revokedAt === null && Date.parse(session.expiresAt) > now,
    );
    for (const session of active) retainedIds.add(session.id);

    const retired = userSessions
      .filter((session) => !active.includes(session))
      .filter((session) => {
        const retiredAt = session.revokedAt
          ? Date.parse(session.revokedAt)
          : Date.parse(session.expiresAt);
        return retiredAt > now - retentionMs;
      })
      .sort((left, right) => {
        const leftRetiredAt = Date.parse(left.revokedAt ?? left.expiresAt);
        const rightRetiredAt = Date.parse(right.revokedAt ?? right.expiresAt);
        return rightRetiredAt - leftRetiredAt;
      })
      .slice(0, maximumRetiredSessionsPerUser);
    for (const session of retired) retainedIds.add(session.id);
  }
  database.sessions = database.sessions.filter((session) => retainedIds.has(session.id));
}

function dummyPasswordHash(options: PasswordHashOptions): string {
  return [
    "scrypt",
    String(options.cost),
    String(options.blockSize),
    String(options.parallelization),
    Buffer.alloc(options.saltLength).toString("base64url"),
    Buffer.alloc(options.keyLength).toString("base64url"),
  ].join("$");
}

function revokeSessions(
  database: AuthDatabase,
  userId: string,
  revokedAt: string,
  reason: string,
): number {
  let count = 0;
  for (const session of database.sessions) {
    if (session.userId === userId && session.revokedAt === null) {
      session.revokedAt = revokedAt;
      session.revocationReason = reason;
      count += 1;
    }
  }
  return count;
}

export class AuthService {
  private readonly clock: () => Date;
  private readonly sessionTtlMs: number;
  private readonly maxAuditRecords: number;
  private readonly maxActiveSessionsPerUser: number;
  private readonly maxRetiredSessionsPerUser: number;
  private readonly retiredSessionRetentionMs: number;
  private readonly passwordHashOptions: PasswordHashOptions;
  private readonly dummyPasswordHash: string;

  constructor(
    readonly store: AuthStore,
    options: AuthServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxAuditRecords = options.maxAuditRecords ?? 10_000;
    this.maxActiveSessionsPerUser = options.maxActiveSessionsPerUser
      ?? DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER;
    this.maxRetiredSessionsPerUser = options.maxRetiredSessionsPerUser
      ?? DEFAULT_MAX_RETIRED_SESSIONS_PER_USER;
    this.retiredSessionRetentionMs = options.retiredSessionRetentionMs
      ?? DEFAULT_RETIRED_SESSION_RETENTION_MS;
    this.passwordHashOptions = validateHashOptions(options.passwordHash);
    this.dummyPasswordHash = dummyPasswordHash(this.passwordHashOptions);
    if (
      !Number.isSafeInteger(this.sessionTtlMs) ||
      this.sessionTtlMs < 1_000 ||
      this.sessionTtlMs > MAX_SESSION_TTL_MS ||
      !Number.isSafeInteger(this.maxAuditRecords) ||
      this.maxAuditRecords < 100 ||
      this.maxAuditRecords > 1_000_000 ||
      !Number.isSafeInteger(this.maxActiveSessionsPerUser) ||
      this.maxActiveSessionsPerUser < 1 ||
      this.maxActiveSessionsPerUser > 1_000 ||
      !Number.isSafeInteger(this.maxRetiredSessionsPerUser) ||
      this.maxRetiredSessionsPerUser < 0 ||
      this.maxRetiredSessionsPerUser > 10_000 ||
      !Number.isSafeInteger(this.retiredSessionRetentionMs) ||
      this.retiredSessionRetentionMs < 0 ||
      this.retiredSessionRetentionMs > MAX_SESSION_TTL_MS
    ) {
      throw new AuthError("The auth service configuration is invalid.", 500, "INVALID_AUTH_CONFIG");
    }
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new AuthError("The auth service clock is invalid.", 500, "INVALID_AUTH_CONFIG");
    }
    return new Date(value.getTime());
  }

  private async mutate<Result>(
    mutation: (database: AuthDatabase) => Result | Promise<Result>,
  ): Promise<Result> {
    return this.store.mutate(async (database) => {
      pruneInactiveSessions(
        database,
        this.now().getTime(),
        this.retiredSessionRetentionMs,
        this.maxRetiredSessionsPerUser,
      );
      const result = await mutation(database);
      pruneInactiveSessions(
        database,
        this.now().getTime(),
        this.retiredSessionRetentionMs,
        this.maxRetiredSessionsPerUser,
      );
      return result;
    });
  }

  async bootstrapRequired(): Promise<boolean> {
    return (await this.store.read()).users.length === 0;
  }

  async bootstrapFirstAdmin(
    input: CreateUserInput,
    context: AuditContext = {},
  ): Promise<SessionGrant> {
    if (!(await this.bootstrapRequired())) {
      throw new AuthError("The administrator account has already been bootstrapped.", 409, "BOOTSTRAP_COMPLETE");
    }
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    const passwordHash = await hashPassword(input.password, this.passwordHashOptions);

    return this.mutate((database) => {
      if (database.users.length !== 0) {
        throw new AuthError("The administrator account has already been bootstrapped.", 409, "BOOTSTRAP_COMPLETE");
      }
      const now = this.now();
      const timestamp = now.toISOString();
      const user: StoredAuthUser = {
        id: randomUUID(),
        email,
        displayName,
        passwordHash,
        role: "admin",
        disabledAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.users.push(user);
      const grant = issueSession(
        database,
        user,
        now,
        this.sessionTtlMs,
        this.maxActiveSessionsPerUser,
      );
      appendAudit(database, {
        action: "admin.bootstrap",
        actorUserId: user.id,
        targetUserId: user.id,
        sessionId: grant.sessionId,
      }, context, timestamp, this.maxAuditRecords);
      return grant;
    });
  }

  async bootstrapFirstUser(
    input: CreateUserInput,
    context: AuditContext = {},
  ): Promise<SessionGrant> {
    return this.bootstrapFirstAdmin(input, context);
  }

  async login(input: LoginInput, context: AuditContext = {}): Promise<SessionGrant> {
    let email: string | undefined;
    try {
      email = normalizeEmail(input.email);
    } catch {
      // Login failures are intentionally indistinguishable to callers.
    }

    const snapshot = await this.store.read();
    const snapshotUser = email
      ? snapshot.users.find((candidate) => candidate.email === email)
      : undefined;
    const verifiedHash = snapshotUser?.passwordHash ?? this.dummyPasswordHash;
    const passwordMatches = await verifyPassword(input.password, verifiedHash);

    const outcome = await this.mutate((database) => {
      const user = email
        ? database.users.find((candidate) => candidate.email === email)
        : undefined;
      const now = this.now();
      const timestamp = now.toISOString();
      if (
        !user ||
        user.disabledAt !== null ||
        !passwordMatches ||
        user.id !== snapshotUser?.id ||
        user.passwordHash !== verifiedHash
      ) {
        appendAudit(database, {
          action: "auth.login_failed",
          targetUserId: user?.id,
          details: { emailFingerprint: emailFingerprint(input.email) },
        }, context, timestamp, this.maxAuditRecords);
        return undefined;
      }

      const grant = issueSession(
        database,
        user,
        now,
        this.sessionTtlMs,
        this.maxActiveSessionsPerUser,
      );
      appendAudit(database, {
        action: "auth.login_succeeded",
        actorUserId: user.id,
        targetUserId: user.id,
        sessionId: grant.sessionId,
      }, context, timestamp, this.maxAuditRecords);
      return grant;
    });

    if (!outcome) {
      throw new AuthError("The email or password is incorrect.", 401, "INVALID_CREDENTIALS");
    }
    return outcome;
  }

  async authenticateSession(token: unknown): Promise<AuthenticatedSession | null> {
    if (!isSessionToken(token)) return null;
    const tokenHash = hashSessionToken(token);
    const database = await this.store.read();
    const session = database.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (
      !session ||
      session.revokedAt !== null ||
      Date.parse(session.expiresAt) <= this.now().getTime()
    ) {
      return null;
    }
    const user = database.users.find((candidate) => candidate.id === session.userId);
    if (!user || user.disabledAt !== null) return null;
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      user: publicUser(user),
    };
  }

  async requireSession(token: unknown): Promise<AuthenticatedSession> {
    const authenticated = await this.authenticateSession(token);
    if (!authenticated) throw new AuthError("Authentication is required.", 401, "AUTH_REQUIRED");
    return authenticated;
  }

  async revokeSession(token: unknown, context: AuditContext = {}): Promise<boolean> {
    if (!isSessionToken(token)) return false;
    const tokenHash = hashSessionToken(token);
    return this.mutate((database) => {
      const session = database.sessions.find((candidate) => candidate.tokenHash === tokenHash);
      if (!session || session.revokedAt !== null) return false;
      const timestamp = this.now().toISOString();
      session.revokedAt = timestamp;
      session.revocationReason = "logout";
      appendAudit(database, {
        action: "auth.logout",
        actorUserId: session.userId,
        targetUserId: session.userId,
        sessionId: session.id,
      }, context, timestamp, this.maxAuditRecords);
      return true;
    });
  }

  async updateOwnProfile(
    actor: AuthenticatedSession,
    input: UpdateOwnProfileInput,
    context: AuditContext = {},
  ): Promise<AuthUser> {
    const displayName = normalizeDisplayName(input.displayName);
    return this.mutate((database) => {
      const authenticated = activeSession(database, actor, this.now().getTime());
      if (authenticated.user.displayName === displayName) {
        throw new AuthError("The update does not change the profile.", 400, "NO_PROFILE_CHANGES");
      }
      const timestamp = this.now().toISOString();
      authenticated.user.displayName = displayName;
      authenticated.user.updatedAt = timestamp;
      appendAudit(database, {
        action: "account.profile_updated",
        actorUserId: authenticated.user.id,
        targetUserId: authenticated.user.id,
        sessionId: authenticated.session.id,
        details: { changes: "displayName" },
      }, context, timestamp, this.maxAuditRecords);
      return publicUser(authenticated.user);
    });
  }

  async changeOwnPassword(
    actor: AuthenticatedSession,
    input: ChangeOwnPasswordInput,
    context: AuditContext = {},
  ): Promise<SessionGrant> {
    const snapshot = await this.store.read();
    const snapshotAuth = activeSession(snapshot, actor, this.now().getTime());
    const verifiedHash = snapshotAuth.user.passwordHash;
    if (!await verifyPassword(input.currentPassword, verifiedHash)) {
      throw new AuthError("The current password is incorrect.", 401, "CURRENT_PASSWORD_INVALID");
    }
    const passwordHash = await hashPassword(input.newPassword, this.passwordHashOptions);

    return this.mutate((database) => {
      const authenticated = activeSession(database, actor, this.now().getTime());
      if (authenticated.user.passwordHash !== verifiedHash) {
        throw new AuthError("The current password is incorrect.", 401, "CURRENT_PASSWORD_INVALID");
      }
      const now = this.now();
      const timestamp = now.toISOString();
      authenticated.user.passwordHash = passwordHash;
      authenticated.user.updatedAt = timestamp;
      const revokedSessions = revokeSessions(
        database,
        authenticated.user.id,
        timestamp,
        "password_changed",
      );
      const grant = issueSession(
        database,
        authenticated.user,
        now,
        this.sessionTtlMs,
        this.maxActiveSessionsPerUser,
      );
      appendAudit(database, {
        action: "account.password_changed",
        actorUserId: authenticated.user.id,
        targetUserId: authenticated.user.id,
        sessionId: grant.sessionId,
        details: { revokedSessions },
      }, context, timestamp, this.maxAuditRecords);
      return grant;
    });
  }

  async createUser(
    actor: AuthenticatedSession,
    input: CreateUserInput,
    context: AuditContext = {},
  ): Promise<AuthUser> {
    activeAdmin(await this.store.read(), actor, this.now().getTime());
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    const role = normalizedRole(input.role, "member");
    const passwordHash = await hashPassword(input.password, this.passwordHashOptions);

    return this.mutate((database) => {
      const administrator = activeAdmin(database, actor, this.now().getTime());
      if (database.users.some((user) => user.email === email)) {
        throw new AuthError("A user with that email already exists.", 409, "EMAIL_EXISTS");
      }
      const timestamp = this.now().toISOString();
      const user: StoredAuthUser = {
        id: randomUUID(),
        email,
        displayName,
        passwordHash,
        role,
        disabledAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.users.push(user);
      appendAudit(database, {
        action: "admin.user_created",
        actorUserId: administrator.user.id,
        targetUserId: user.id,
        sessionId: administrator.session.id,
        details: { role },
      }, context, timestamp, this.maxAuditRecords);
      return publicUser(user);
    });
  }

  async listUsers(actor: AuthenticatedSession): Promise<AuthUser[]> {
    const database = await this.store.read();
    activeAdmin(database, actor, this.now().getTime());
    return database.users
      .map(publicUser)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async updateUser(
    actor: AuthenticatedSession,
    userIdValue: unknown,
    input: UpdateUserInput,
    context: AuditContext = {},
  ): Promise<AuthUser> {
    activeAdmin(await this.store.read(), actor, this.now().getTime());
    const userId = normalizedUserId(userIdValue);
    const email = input.email === undefined ? undefined : normalizeEmail(input.email);
    const displayName = input.displayName === undefined
      ? undefined
      : normalizeDisplayName(input.displayName);
    const role = input.role === undefined ? undefined : normalizedRole(input.role);
    if (input.disabled !== undefined && typeof input.disabled !== "boolean") {
      invalidInput("The disabled flag must be a boolean.", "INVALID_DISABLED_FLAG");
    }
    const passwordHash = input.password === undefined
      ? undefined
      : await hashPassword(input.password, this.passwordHashOptions);

    if (
      email === undefined &&
      displayName === undefined &&
      role === undefined &&
      input.disabled === undefined &&
      passwordHash === undefined
    ) {
      invalidInput("At least one user field must be supplied.", "EMPTY_USER_UPDATE");
    }

    return this.mutate((database) => {
      const administrator = activeAdmin(database, actor, this.now().getTime());
      const user = database.users.find((candidate) => candidate.id === userId);
      if (!user) throw new AuthError("The user was not found.", 404, "USER_NOT_FOUND");
      if (email && database.users.some((candidate) => candidate.id !== user.id && candidate.email === email)) {
        throw new AuthError("A user with that email already exists.", 409, "EMAIL_EXISTS");
      }

      const disabling = input.disabled === true && user.disabledAt === null;
      const enabling = input.disabled === false && user.disabledAt !== null;
      const demoting = role !== undefined && role !== "admin" && user.role === "admin";
      if ((disabling || demoting) && user.role === "admin" && user.disabledAt === null) {
        const enabledAdministrators = database.users.filter(
          (candidate) => candidate.role === "admin" && candidate.disabledAt === null,
        ).length;
        if (enabledAdministrators <= 1) {
          throw new AuthError("The last enabled administrator cannot be disabled or demoted.", 409, "LAST_ADMIN");
        }
      }

      const changes: string[] = [];
      if (email !== undefined && email !== user.email) {
        user.email = email;
        changes.push("email");
      }
      if (displayName !== undefined && displayName !== user.displayName) {
        user.displayName = displayName;
        changes.push("displayName");
      }
      if (role !== undefined && role !== user.role) {
        user.role = role;
        changes.push("role");
      }
      if (passwordHash !== undefined) {
        user.passwordHash = passwordHash;
        changes.push("password");
      }

      const timestamp = this.now().toISOString();
      if (disabling) {
        user.disabledAt = timestamp;
        changes.push("disabled");
      } else if (enabling) {
        user.disabledAt = null;
        changes.push("enabled");
      }
      if (changes.length === 0) {
        throw new AuthError("The update does not change the user.", 400, "NO_USER_CHANGES");
      }
      user.updatedAt = timestamp;

      let revokedSessions = 0;
      if (disabling || passwordHash !== undefined || (role !== undefined && changes.includes("role"))) {
        const reason = disabling
          ? "user_disabled"
          : passwordHash !== undefined
            ? "password_changed"
            : "role_changed";
        revokedSessions = revokeSessions(database, user.id, timestamp, reason);
      }
      const action: AuditAction = disabling
        ? "admin.user_disabled"
        : enabling
          ? "admin.user_enabled"
          : "admin.user_updated";
      appendAudit(database, {
        action,
        actorUserId: administrator.user.id,
        targetUserId: user.id,
        sessionId: administrator.session.id,
        details: { changes: changes.join(","), revokedSessions },
      }, context, timestamp, this.maxAuditRecords);
      return publicUser(user);
    });
  }

  async disableUser(
    actor: AuthenticatedSession,
    userId: unknown,
    context: AuditContext = {},
  ): Promise<AuthUser> {
    return this.updateUser(actor, userId, { disabled: true }, context);
  }

  async enableUser(
    actor: AuthenticatedSession,
    userId: unknown,
    context: AuditContext = {},
  ): Promise<AuthUser> {
    return this.updateUser(actor, userId, { disabled: false }, context);
  }

  async revokeUserSessions(
    actor: AuthenticatedSession,
    userIdValue: unknown,
    context: AuditContext = {},
  ): Promise<number> {
    const userId = normalizedUserId(userIdValue);
    return this.mutate((database) => {
      const administrator = activeAdmin(database, actor, this.now().getTime());
      const user = database.users.find((candidate) => candidate.id === userId);
      if (!user) throw new AuthError("The user was not found.", 404, "USER_NOT_FOUND");
      const timestamp = this.now().toISOString();
      const count = revokeSessions(database, user.id, timestamp, "admin_revoked");
      appendAudit(database, {
        action: "admin.sessions_revoked",
        actorUserId: administrator.user.id,
        targetUserId: user.id,
        sessionId: administrator.session.id,
        details: { revokedSessions: count },
      }, context, timestamp, this.maxAuditRecords);
      return count;
    });
  }

  async listAuditRecords(
    actor: AuthenticatedSession,
    limit = 100,
  ): Promise<StoredAuditRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      invalidInput("The audit limit must be between 1 and 500.", "INVALID_AUDIT_LIMIT");
    }
    const database = await this.store.read();
    activeAdmin(database, actor, this.now().getTime());
    return database.audit.slice(-limit).reverse();
  }
}
