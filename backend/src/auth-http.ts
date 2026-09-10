import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  AuthError,
  type AuthenticatedSession,
  type AuditContext,
  type AuthService,
  isSessionToken,
  type SessionGrant,
} from "./auth-service.js";

export const DEFAULT_SESSION_COOKIE_NAME = "one_shot_session";
export const AUTH_RESPONSE_LOCAL = "auth";

export type SameSitePolicy = "lax" | "strict";

export type SessionCookieConfig = {
  /** Defaults to true. Set false only when the browser reaches the app over HTTP. */
  secure?: boolean;
  name?: string;
  path?: string;
  sameSite?: SameSitePolicy;
};

export type AuthResponseLocals = {
  auth?: AuthenticatedSession;
};

type NormalizedCookieConfig = {
  secure: boolean;
  name: string;
  path: string;
  sameSite: SameSitePolicy;
};

function normalizeCookieConfig(config: SessionCookieConfig = {}): NormalizedCookieConfig {
  const name = config.name ?? DEFAULT_SESSION_COOKIE_NAME;
  const path = config.path ?? "/";
  const sameSite = config.sameSite ?? "lax";
  const secure = config.secure ?? true;
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new AuthError("The session cookie name is invalid.", 500, "INVALID_AUTH_CONFIG");
  }
  if (!path.startsWith("/") || /[;\r\n]/.test(path)) {
    throw new AuthError("The session cookie path is invalid.", 500, "INVALID_AUTH_CONFIG");
  }
  if (sameSite !== "lax" && sameSite !== "strict") {
    throw new AuthError("The session cookie SameSite policy is invalid.", 500, "INVALID_AUTH_CONFIG");
  }
  if (typeof secure !== "boolean") {
    throw new AuthError("The session cookie Secure setting is invalid.", 500, "INVALID_AUTH_CONFIG");
  }
  if (name.startsWith("__Host-") && (!secure || path !== "/")) {
    throw new AuthError("A __Host- cookie must be Secure and use Path=/.", 500, "INVALID_AUTH_CONFIG");
  }
  if (name.startsWith("__Secure-") && !secure) {
    throw new AuthError("A __Secure- cookie must be Secure.", 500, "INVALID_AUTH_CONFIG");
  }
  return { secure, name, path, sameSite };
}

function sameSiteAttribute(policy: SameSitePolicy): string {
  return policy === "strict" ? "Strict" : "Lax";
}

export function serializeSessionCookie(
  session: Pick<SessionGrant, "token" | "expiresAt">,
  config: SessionCookieConfig = {},
  now: Date = new Date(),
): string {
  if (!isSessionToken(session.token)) {
    throw new AuthError("The session token is invalid.", 500, "INVALID_SESSION_TOKEN");
  }
  const expiresAt = new Date(session.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(now.getTime())) {
    throw new AuthError("The session expiry is invalid.", 500, "INVALID_SESSION_EXPIRY");
  }
  const normalized = normalizeCookieConfig(config);
  const maxAge = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000));
  const attributes = [
    `${normalized.name}=${session.token}`,
    `Path=${normalized.path}`,
    "HttpOnly",
    `SameSite=${sameSiteAttribute(normalized.sameSite)}`,
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${maxAge}`,
    ...(normalized.secure ? ["Secure"] : []),
  ];
  return attributes.join("; ");
}

export function serializeClearedSessionCookie(config: SessionCookieConfig = {}): string {
  const normalized = normalizeCookieConfig(config);
  const attributes = [
    `${normalized.name}=`,
    `Path=${normalized.path}`,
    "HttpOnly",
    `SameSite=${sameSiteAttribute(normalized.sameSite)}`,
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
    ...(normalized.secure ? ["Secure"] : []),
  ];
  return attributes.join("; ");
}

export function setSessionCookie(
  response: Response,
  session: Pick<SessionGrant, "token" | "expiresAt">,
  config: SessionCookieConfig = {},
): void {
  response.append("Set-Cookie", serializeSessionCookie(session, config));
}

export function clearSessionCookie(
  response: Response,
  config: SessionCookieConfig = {},
): void {
  response.append("Set-Cookie", serializeClearedSessionCookie(config));
}

function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    const rawValue = pair.slice(separator + 1).trim();
    try {
      values.push(decodeURIComponent(rawValue));
    } catch {
      values.push("");
    }
  }
  return values;
}

function sessionCookie(request: Request, config: SessionCookieConfig = {}) {
  const normalized = normalizeCookieConfig(config);
  const values = cookieValues(request.headers.cookie, normalized.name);
  if (values.length !== 1 || !isSessionToken(values[0])) {
    return { present: values.length > 0, token: undefined };
  }
  return { present: true, token: values[0] };
}

export function getSessionTokenFromRequest(
  request: Request,
  config: SessionCookieConfig = {},
): string | undefined {
  return sessionCookie(request, config).token;
}

export function getAuthenticatedSession(response: Response): AuthenticatedSession | undefined {
  const value = response.locals[AUTH_RESPONSE_LOCAL] as AuthenticatedSession | undefined;
  return value;
}

export function requireAuthenticatedSession(response: Response): AuthenticatedSession {
  const authenticated = getAuthenticatedSession(response);
  if (!authenticated) throw new AuthError("Authentication is required.", 401, "AUTH_REQUIRED");
  return authenticated;
}

export function auditContextFromRequest(request: Request): AuditContext {
  return {
    ipAddress: request.ip,
    userAgent: request.get("user-agent"),
    requestId: request.get("x-request-id"),
  };
}

export async function authenticateRequest(
  service: AuthService,
  request: Request,
  config: SessionCookieConfig = {},
): Promise<AuthenticatedSession | null> {
  return service.authenticateSession(getSessionTokenFromRequest(request, config));
}

/** Populates `response.locals.auth` when a valid session cookie is present. */
export function createAuthenticationMiddleware(
  service: AuthService,
  config: SessionCookieConfig = {},
): RequestHandler {
  return (request, response, next) => {
    const cookie = sessionCookie(request, config);
    void service.authenticateSession(cookie.token).then((authenticated) => {
      if (authenticated) {
        response.locals[AUTH_RESPONSE_LOCAL] = authenticated;
        response.set("Cache-Control", "private, no-store");
      } else {
        delete response.locals[AUTH_RESPONSE_LOCAL];
        if (cookie.present) clearSessionCookie(response, config);
      }
      next();
    }).catch(next);
  };
}

export const createAuthMiddleware = createAuthenticationMiddleware;

export function requireAuthentication(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!getAuthenticatedSession(response)) {
    next(new AuthError("Authentication is required.", 401, "AUTH_REQUIRED"));
    return;
  }
  next();
}

export function requireAdministrator(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  const authenticated = getAuthenticatedSession(response);
  if (!authenticated) {
    next(new AuthError("Authentication is required.", 401, "AUTH_REQUIRED"));
    return;
  }
  if (authenticated.user.role !== "admin") {
    next(new AuthError("Administrator access is required.", 403, "ADMIN_REQUIRED"));
    return;
  }
  next();
}
