"use client";

import { AlertTriangle, Film, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ApiError, type ApiRequest, fetchApi } from "@/lib/api-client";

export type AuthRole = "admin" | "member";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: AuthRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type AuthenticatedResponse = {
  authenticated: true;
  user: AuthUser;
  expiresAt: string;
  csrfToken: string;
};

type UnauthenticatedResponse = {
  authenticated: false;
  setupRequired: boolean;
  setupTokenRequired?: boolean;
};

type SessionResponse = AuthenticatedResponse | UnauthenticatedResponse;

type SessionState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "unauthenticated"; setupRequired: boolean }
  | {
      status: "authenticated";
      user: AuthUser;
      expiresAt: string;
      csrfToken: string;
    };

export type AuthContextValue = {
  status: SessionState["status"];
  user: AuthUser | null;
  expiresAt: string | null;
  csrfToken: string | null;
  setupRequired: boolean;
  secureTransport: boolean;
  request: ApiRequest;
  apiRequest: ApiRequest;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  bootstrap: (
    displayName: string,
    email: string,
    password: string,
    setupToken: string,
  ) => Promise<void>;
  updateProfile: (displayName: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function mutation(method: string | undefined) {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

function sessionResponse(value: unknown): SessionResponse {
  if (!value || typeof value !== "object") {
    throw new Error("The backend returned an invalid session response.");
  }
  const candidate = value as Partial<SessionResponse>;
  if (candidate.authenticated === false && typeof candidate.setupRequired === "boolean") {
    return candidate as UnauthenticatedResponse;
  }
  if (
    candidate.authenticated === true &&
    candidate.user &&
    typeof candidate.user === "object" &&
    typeof candidate.expiresAt === "string" &&
    typeof candidate.csrfToken === "string" &&
    candidate.csrfToken.length > 0
  ) {
    const user = candidate.user as Partial<AuthUser>;
    if (
      typeof user.id === "string" &&
      typeof user.email === "string" &&
      typeof user.displayName === "string" &&
      (user.role === "admin" || user.role === "member") &&
      typeof user.disabled === "boolean" &&
      typeof user.createdAt === "string" &&
      typeof user.updatedAt === "string"
    ) {
      return candidate as AuthenticatedResponse;
    }
  }
  throw new Error("The backend returned an invalid session response.");
}

function transportIsSecure() {
  if (window.location.protocol === "https:") return true;
  const hostname = window.location.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function authMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function InsecureConnectionWarning({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={compact ? "auth-insecure-notice" : "auth-insecure-banner"}
      role="alert"
    >
      <AlertTriangle aria-hidden="true" size={compact ? 17 : 15} />
      <span>
        <strong>HTTPS is required.</strong>{" "}
        This connection is not encrypted, so password and account changes are disabled.
      </span>
    </div>
  );
}

function AuthenticationScreen({
  state,
  secureTransport,
  onBootstrap,
  onLogin,
  onRetry,
}: {
  state: Exclude<SessionState, { status: "authenticated" }>;
  secureTransport: boolean | null;
  onBootstrap: (
    displayName: string,
    email: string,
    password: string,
    setupToken: string,
  ) => Promise<void>;
  onLogin: (email: string, password: string) => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const setupRequired = state.status === "unauthenticated" && state.setupRequired;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (secureTransport !== true || busy || state.status !== "unauthenticated") return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    try {
      if (setupRequired) {
        const confirmation = String(form.get("passwordConfirmation") ?? "");
        if (password !== confirmation) {
          throw new Error("The passwords do not match.");
        }
        await onBootstrap(
          String(form.get("displayName") ?? ""),
          email,
          password,
          String(form.get("setupToken") ?? ""),
        );
      } else {
        await onLogin(email, password);
      }
    } catch (cause) {
      setError(authMessage(cause, setupRequired ? "Setup failed." : "Sign in failed."));
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") {
    return (
      <main className="auth-page" aria-busy="true">
        <div className="auth-loading-card">
          <span className="auth-logo"><Film aria-hidden="true" size={22} /></span>
          <LoaderCircle aria-hidden="true" className="spin" size={22} />
          <p>Opening your workspace…</p>
        </div>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="auth-page">
        <section className="auth-card auth-error-card" aria-labelledby="auth-error-title">
          <span className="auth-logo"><Film aria-hidden="true" size={22} /></span>
          <span className="auth-kicker">ONETAKE</span>
          <h1 id="auth-error-title">The backend is unavailable.</h1>
          <p>{state.message}</p>
          <button className="auth-primary-button" onClick={() => void onRetry()} type="button">
            Try again
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand-row">
          <span className="auth-logo"><Film aria-hidden="true" size={22} /></span>
          <span>OneTake</span>
        </div>
        <span className="auth-kicker">{setupRequired ? "SECURE SETUP" : "WELCOME BACK"}</span>
        <h1 id="auth-title">
          {setupRequired ? "Create the first administrator." : "Sign in to your workspace."}
        </h1>
        <p className="auth-intro">
          {setupRequired
            ? "This one-time account owns user administration. Additional accounts can only be created by an administrator."
            : "Your projects and generated media are stored on the backend and isolated to your account."}
        </p>

        {secureTransport === false ? <InsecureConnectionWarning compact /> : null}

        <form className="auth-form" onSubmit={submit}>
          {setupRequired ? (
            <>
              <label>
                <span>Server setup token</span>
                <input
                  autoComplete="off"
                  autoFocus
                  disabled={busy || secureTransport !== true}
                  name="setupToken"
                  required
                  type="password"
                />
                <small>Use the BACKEND_BOOTSTRAP_TOKEN configured on the server.</small>
              </label>
              <label>
                <span>Display name</span>
                <input
                  autoComplete="name"
                  disabled={busy || secureTransport !== true}
                  maxLength={80}
                  name="displayName"
                  required
                  type="text"
                />
              </label>
            </>
          ) : null}
          <label>
            <span>Email</span>
            <input
              autoComplete="username"
              autoFocus={!setupRequired}
              disabled={busy || secureTransport !== true}
              inputMode="email"
              maxLength={254}
              name="email"
              required
              type="email"
            />
          </label>
          <label>
            <span>Password</span>
            <input
              autoComplete={setupRequired ? "new-password" : "current-password"}
              disabled={busy || secureTransport !== true}
              minLength={setupRequired ? 12 : undefined}
              name="password"
              required
              type="password"
            />
            {setupRequired ? <small>Use at least 12 characters.</small> : null}
          </label>
          {setupRequired ? (
            <label>
              <span>Confirm password</span>
              <input
                autoComplete="new-password"
                disabled={busy || secureTransport !== true}
                minLength={12}
                name="passwordConfirmation"
                required
                type="password"
              />
            </label>
          ) : null}

          {error ? <p className="auth-form-error" role="alert">{error}</p> : null}
          <button
            className="auth-primary-button"
            disabled={busy || secureTransport !== true}
            type="submit"
          >
            {busy ? <LoaderCircle aria-hidden="true" className="spin" size={17} /> : <LockKeyhole aria-hidden="true" size={17} />}
            {busy ? "Please wait…" : setupRequired ? "Create administrator" : "Sign in"}
          </button>
        </form>

        <div className="auth-security-note">
          <ShieldCheck aria-hidden="true" size={17} />
          <span>Only a protected session cookie is kept in this browser. Project data stays on the backend.</span>
        </div>
      </section>
    </main>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [secureTransport, setSecureTransport] = useState<boolean | null>(null);
  const csrfTokenRef = useRef<string | null>(null);
  const refreshSequence = useRef(0);

  const applyResponse = useCallback((response: SessionResponse) => {
    if (response.authenticated) {
      csrfTokenRef.current = response.csrfToken;
      setState({ status: "authenticated", ...response });
      return;
    }
    csrfTokenRef.current = null;
    setState({
      status: "unauthenticated",
      setupRequired: response.setupRequired,
    });
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const response = sessionResponse(await fetchApi<unknown>("/api/auth/session", {
        cache: "no-store",
      }));
      if (sequence === refreshSequence.current) applyResponse(response);
    } catch (cause) {
      if (sequence !== refreshSequence.current) return;
      setState((current) => current.status === "authenticated"
        ? current
        : {
            status: "error",
            message: authMessage(cause, "The session could not be checked."),
          });
    }
  }, [applyResponse]);

  useEffect(() => {
    setSecureTransport(transportIsSecure());
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (state.status !== "authenticated") return;
    const expiry = Date.parse(state.expiresAt);
    if (!Number.isFinite(expiry)) return;
    const delay = Math.max(0, Math.min(expiry - Date.now() + 250, 2_147_000_000));
    const timeout = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timeout);
  }, [refresh, state]);

  useEffect(() => {
    const checkOnReturn = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", checkOnReturn);
    return () => document.removeEventListener("visibilitychange", checkOnReturn);
  }, [refresh]);

  const request = useCallback<ApiRequest>(async <ResponseBody,>(
    url: string,
    init: RequestInit = {},
  ): Promise<ResponseBody> => {
    const token = csrfTokenRef.current;
    if (mutation(init.method) && !token) {
      throw new ApiError("Your session has expired. Sign in again.", {
        status: 401,
        code: "AUTH_REQUIRED",
      });
    }
    try {
      return await fetchApi<ResponseBody>(url, init, token ?? undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        csrfTokenRef.current = null;
        setState({ status: "unauthenticated", setupRequired: false });
      }
      throw cause;
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    if (secureTransport !== true) {
      throw new Error("Enable HTTPS before sending a password.");
    }
    const response = sessionResponse(await fetchApi<unknown>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }));
    if (!response.authenticated) throw new Error("Sign in did not create a session.");
    applyResponse(response);
  }, [applyResponse, secureTransport]);

  const bootstrap = useCallback(async (
    displayName: string,
    email: string,
    password: string,
    setupToken: string,
  ) => {
    if (secureTransport !== true) {
      throw new Error("Enable HTTPS before sending a password.");
    }
    const response = sessionResponse(await fetchApi<unknown>("/api/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, email, password, setupToken }),
    }));
    if (!response.authenticated) throw new Error("Setup did not create a session.");
    applyResponse(response);
  }, [applyResponse, secureTransport]);

  const logout = useCallback(async () => {
    const token = csrfTokenRef.current;
    if (!token) {
      setState({ status: "unauthenticated", setupRequired: false });
      return;
    }
    await fetchApi<void>("/api/auth/logout", { method: "POST" }, token);
    csrfTokenRef.current = null;
    setState({ status: "unauthenticated", setupRequired: false });
  }, []);

  const updateProfile = useCallback(async (displayName: string) => {
    await request<{ user: AuthUser }>("/api/account/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    await refresh();
  }, [refresh, request]);

  const changePassword = useCallback(async (
    currentPassword: string,
    newPassword: string,
  ) => {
    const response = sessionResponse(await request<unknown>("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    }));
    if (!response.authenticated) throw new Error("The password change did not create a session.");
    applyResponse(response);
  }, [applyResponse, request]);

  const value = useMemo<AuthContextValue>(() => ({
    status: state.status,
    user: state.status === "authenticated" ? state.user : null,
    expiresAt: state.status === "authenticated" ? state.expiresAt : null,
    csrfToken: state.status === "authenticated" ? state.csrfToken : null,
    setupRequired: state.status === "unauthenticated" && state.setupRequired,
    secureTransport: secureTransport === true,
    request,
    apiRequest: request,
    refresh,
    login,
    bootstrap,
    updateProfile,
    changePassword,
    logout,
  }), [
    bootstrap,
    changePassword,
    login,
    logout,
    refresh,
    request,
    secureTransport,
    state,
    updateProfile,
  ]);

  const publicState = state.status === "authenticated" ? null : state;

  return (
    <AuthContext.Provider value={value}>
      {publicState ? (
        <AuthenticationScreen
          onBootstrap={bootstrap}
          onLogin={login}
          onRetry={refresh}
          secureTransport={secureTransport}
          state={publicState}
        />
      ) : (
        <>
          {secureTransport === false ? <InsecureConnectionWarning /> : null}
          {children}
        </>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider.");
  return value;
}
