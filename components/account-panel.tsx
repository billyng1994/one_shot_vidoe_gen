"use client";

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  Copy,
  Cpu,
  HardDrive,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { type AuthRole, type AuthUser, useAuth } from "@/components/auth-provider";

type AccountPanelProps = {
  open: boolean;
  onClose: () => void;
};

type PanelTab = "account" | "users" | "provider" | "audit";

type ProviderAdminStatus = {
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
    callbackPort: number;
    tunnelCommand: string;
    command: string;
    description: string;
  };
};

type AuditRecord = {
  id: string;
  action: string;
  actorUserId: string | null;
  targetUserId: string | null;
  sessionId: string | null;
  occurredAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  details: Record<string, string | number | boolean | null>;
};

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : name.slice(0, 2))
    .toUpperCase();
}

function readableDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function actionLabel(value: string) {
  return value
    .replace(/^admin\.|^auth\./u, "")
    .replaceAll("_", " ")
    .replace(/^\w/u, (character) => character.toUpperCase());
}

function parseProviderStatus(value: unknown): ProviderAdminStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The backend returned an invalid provider status.");
  }
  const candidate = value as Partial<ProviderAdminStatus>;
  const cli = candidate.cli as Partial<ProviderAdminStatus["cli"]> | undefined;
  const storage = candidate.storage as Partial<ProviderAdminStatus["storage"]> | undefined;
  const models = candidate.models as Partial<ProviderAdminStatus["models"]> | undefined;
  const connection = candidate.connection as Partial<ProviderAdminStatus["connection"]> | undefined;
  if (
    candidate.provider !== "Higgsfield CLI" ||
    typeof candidate.configured !== "boolean" ||
    typeof candidate.mockMode !== "boolean" ||
    typeof cli?.installed !== "boolean" ||
    typeof cli.authenticated !== "boolean" ||
    (cli.version !== undefined && typeof cli.version !== "string") ||
    typeof storage?.writable !== "boolean" ||
    typeof models?.image !== "string" ||
    typeof models.video !== "string" ||
    connection?.kind !== "ssh-loopback" ||
    typeof connection.callbackPort !== "number" ||
    !Number.isSafeInteger(connection.callbackPort) ||
    (connection.callbackPort ?? 0) < 1 ||
    (connection.callbackPort ?? 0) > 65_535 ||
    typeof connection.tunnelCommand !== "string" ||
    connection.tunnelCommand.length === 0 ||
    typeof connection.command !== "string" ||
    connection.command.length === 0 ||
    typeof connection.description !== "string"
  ) {
    throw new Error("The backend returned an invalid provider status.");
  }
  return candidate as ProviderAdminStatus;
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy was not accepted by the browser.");
  } finally {
    textarea.remove();
  }
}

function UserEditor({
  currentUserId,
  disabled,
  user,
  onRevokeSessions,
  onSave,
}: {
  currentUserId: string;
  disabled: boolean;
  user: AuthUser;
  onRevokeSessions: (user: AuthUser) => Promise<void>;
  onSave: (user: AuthUser, update: Record<string, unknown>) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<AuthRole>(user.role);
  const [isDisabled, setIsDisabled] = useState(user.disabled);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"save" | "revoke" | null>(null);
  const [error, setError] = useState("");

  const changed =
    displayName.trim() !== user.displayName ||
    email.trim().toLowerCase() !== user.email ||
    role !== user.role ||
    isDisabled !== user.disabled ||
    password.length > 0;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!changed || busy || disabled) return;
    setBusy("save");
    setError("");
    const update: Record<string, unknown> = {};
    if (displayName.trim() !== user.displayName) update.displayName = displayName;
    if (email.trim().toLowerCase() !== user.email) update.email = email;
    if (role !== user.role) update.role = role;
    if (isDisabled !== user.disabled) update.disabled = isDisabled;
    if (password) update.password = password;
    try {
      await onSave(user, update);
      setPassword("");
    } catch (cause) {
      setError(messageFrom(cause, "The user could not be updated."));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (busy || disabled) return;
    const subject = user.id === currentUserId ? "your own" : `${user.displayName}’s`;
    if (!window.confirm(`Revoke all of ${subject} active sessions?`)) return;
    setBusy("revoke");
    setError("");
    try {
      await onRevokeSessions(user);
    } catch (cause) {
      setError(messageFrom(cause, "Sessions could not be revoked."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className={`account-user-card ${user.disabled ? "is-disabled" : ""}`} onSubmit={save}>
      <div className="account-user-summary">
        <span className="account-avatar" aria-hidden="true">{initials(user.displayName)}</span>
        <div>
          <strong>{user.displayName}</strong>
          <span>{user.email}</span>
        </div>
        <span className={`account-user-status ${user.disabled ? "is-disabled" : ""}`}>
          {user.disabled ? "Disabled" : user.role}
        </span>
      </div>

      <div className="account-form-grid">
        <label>
          <span>Display name</span>
          <input
            disabled={disabled || busy !== null}
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            type="text"
            value={displayName}
          />
        </label>
        <label>
          <span>Email</span>
          <input
            disabled={disabled || busy !== null}
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label>
          <span>Role</span>
          <select
            disabled={disabled || busy !== null}
            onChange={(event) => setRole(event.target.value as AuthRole)}
            value={role}
          >
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
        <label>
          <span>New password</span>
          <input
            autoComplete="new-password"
            disabled={disabled || busy !== null}
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Leave unchanged"
            type="password"
            value={password}
          />
        </label>
      </div>

      <label className="account-switch-row">
        <input
          checked={isDisabled}
          disabled={disabled || busy !== null}
          onChange={(event) => setIsDisabled(event.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>Disable account</strong>
          <small>Immediately blocks sign-in and revokes active sessions.</small>
        </span>
      </label>

      {error ? <p className="account-inline-error" role="alert">{error}</p> : null}
      <div className="account-user-actions">
        <button
          className="account-secondary-button"
          disabled={disabled || busy !== null}
          onClick={() => void revoke()}
          type="button"
        >
          {busy === "revoke" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          Revoke sessions
        </button>
        <button
          className="account-save-button"
          disabled={disabled || busy !== null || !changed}
          type="submit"
        >
          {busy === "save" ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}
          Save changes
        </button>
      </div>
    </form>
  );
}

export function AccountPanel({ open, onClose }: AccountPanelProps) {
  const {
    changePassword,
    logout,
    refresh,
    request,
    secureTransport,
    updateProfile,
    user,
  } = useAuth();
  const titleId = useId();
  const [tab, setTab] = useState<PanelTab>("account");
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [loadingAdmin, setLoadingAdmin] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [notice, setNotice] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [creating, setCreating] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderAdminStatus | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [copyState, setCopyState] = useState<{
    target: "tunnel" | "login";
    status: "copied" | "error";
  } | null>(null);
  const [showProviderGuide, setShowProviderGuide] = useState(false);
  const providerGuideRef = useRef<HTMLDivElement>(null);

  const isAdmin = user?.role === "admin";

  const loadAdminData = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingAdmin(true);
    setAdminError("");
    try {
      const [userResponse, auditResponse] = await Promise.all([
        request<{ users: AuthUser[] }>("/api/admin/users", { cache: "no-store" }),
        request<{ records: AuditRecord[] }>("/api/admin/audit?limit=50", { cache: "no-store" }),
      ]);
      setUsers(userResponse.users);
      setAudit(auditResponse.records);
    } catch (cause) {
      setAdminError(messageFrom(cause, "User management could not be loaded."));
    } finally {
      setLoadingAdmin(false);
    }
  }, [isAdmin, request]);

  const loadProviderStatus = useCallback(async () => {
    if (!isAdmin) return;
    setProviderLoading(true);
    setProviderError("");
    setCopyState(null);
    try {
      const response = await request<unknown>("/api/admin/provider", { cache: "no-store" });
      setProviderStatus(parseProviderStatus(response));
    } catch (cause) {
      setProviderError(messageFrom(cause, "Provider status could not be checked."));
    } finally {
      setProviderLoading(false);
    }
  }, [isAdmin, request]);

  useEffect(() => {
    if (!open) return;
    const loadTimer = window.setTimeout(() => {
      if (isAdmin) void loadAdminData();
    }, 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => {
      window.clearTimeout(loadTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", escape);
    };
  }, [isAdmin, loadAdminData, onClose, open]);

  const usersById = useMemo(
    () => new Map(users.map((candidate) => [candidate.id, candidate])),
    [users],
  );

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating || !secureTransport) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setCreating(true);
    setAdminError("");
    setNotice("");
    try {
      const created = await request<AuthUser>("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: String(form.get("displayName") ?? ""),
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
          role: String(form.get("role") ?? "member"),
        }),
      });
      setUsers((current) => [...current, created]);
      setNotice(`${created.displayName} can now sign in.`);
      formElement.reset();
    } catch (cause) {
      setAdminError(messageFrom(cause, "The user could not be created."));
    } finally {
      setCreating(false);
    }
  };

  const saveUser = async (target: AuthUser, update: Record<string, unknown>) => {
    setNotice("");
    const saved = await request<AuthUser>(`/api/admin/users/${encodeURIComponent(target.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    setUsers((current) => current.map((candidate) => candidate.id === saved.id ? saved : candidate));
    setNotice(`${saved.displayName} was updated.`);
    if (saved.id === user?.id) await refresh();
    await loadAuditOnly();
  };

  const loadAuditOnly = async () => {
    if (!isAdmin) return;
    try {
      const response = await request<{ records: AuditRecord[] }>(
        "/api/admin/audit?limit=50",
        { cache: "no-store" },
      );
      setAudit(response.records);
    } catch {
      // The successful account operation should remain visible even if audit refresh fails.
    }
  };

  const revokeSessions = async (target: AuthUser) => {
    setNotice("");
    const response = await request<{ revoked: number }>(
      `/api/admin/users/${encodeURIComponent(target.id)}/revoke-sessions`,
      { method: "POST" },
    );
    setNotice(`${response.revoked} active session${response.revoked === 1 ? "" : "s"} revoked.`);
    if (target.id === user?.id) await refresh();
    else await loadAuditOnly();
  };

  const signOut = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setAdminError("");
    try {
      await logout();
      onClose();
    } catch (cause) {
      setAdminError(messageFrom(cause, "Sign out failed. Please try again."));
      setLoggingOut(false);
    }
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (profileBusy || !secureTransport || !user) return;
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "");
    if (displayName.trim() === user.displayName) return;
    setProfileBusy(true);
    setAccountError("");
    setNotice("");
    try {
      await updateProfile(displayName);
      setNotice("Your profile was updated.");
    } catch (cause) {
      setAccountError(messageFrom(cause, "Your profile could not be updated."));
    } finally {
      setProfileBusy(false);
    }
  };

  const savePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (passwordBusy || !secureTransport) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmation = String(form.get("passwordConfirmation") ?? "");
    setAccountError("");
    setNotice("");
    if (newPassword !== confirmation) {
      setAccountError("The new passwords do not match.");
      return;
    }
    setPasswordBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      formElement.reset();
      setNotice("Your password was changed and other sessions were signed out.");
    } catch (cause) {
      setAccountError(messageFrom(cause, "Your password could not be changed."));
    } finally {
      setPasswordBusy(false);
    }
  };

  const openProviderTab = () => {
    setTab("provider");
    if (!providerStatus && !providerLoading) void loadProviderStatus();
  };

  const copyProviderCommand = async (
    target: "tunnel" | "login",
    command: string,
  ) => {
    setCopyState(null);
    try {
      await copyToClipboard(command);
      setCopyState({ target, status: "copied" });
    } catch {
      setCopyState({ target, status: "error" });
    }
  };

  const revealProviderGuide = () => {
    setShowProviderGuide(true);
    window.requestAnimationFrame(() => providerGuideRef.current?.focus());
  };

  const providerConnected = providerStatus !== null &&
    providerStatus.configured &&
    providerStatus.storage.writable &&
    (
      providerStatus.mockMode ||
      (providerStatus.cli.installed && providerStatus.cli.authenticated)
    );

  if (!open || !user) return null;

  return createPortal(
    <div
      className="account-modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      role="presentation"
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="account-panel"
        role="dialog"
      >
        <header className="account-panel-header">
          <div>
            <span className="account-panel-kicker">ACCOUNT & ACCESS</span>
            <h2 id={titleId}>Workspace settings</h2>
          </div>
          <button
            aria-label="Close account settings"
            autoFocus
            className="account-icon-button"
            onClick={onClose}
            type="button"
          >
            <X size={19} />
          </button>
        </header>

        <nav className="account-tabs" aria-label="Account settings" role="tablist">
          <button
            aria-selected={tab === "account"}
            className={tab === "account" ? "is-active" : ""}
            onClick={() => setTab("account")}
            role="tab"
            type="button"
          >
            <ShieldCheck size={15} /> Account
          </button>
          {isAdmin ? (
            <>
              <button
                aria-selected={tab === "users"}
                className={tab === "users" ? "is-active" : ""}
                onClick={() => setTab("users")}
                role="tab"
                type="button"
              >
                <Users size={15} /> Users
              </button>
              <button
                aria-selected={tab === "provider"}
                className={tab === "provider" ? "is-active" : ""}
                onClick={openProviderTab}
                role="tab"
                type="button"
              >
                <Server size={15} /> Provider
              </button>
              <button
                aria-selected={tab === "audit"}
                className={tab === "audit" ? "is-active" : ""}
                onClick={() => setTab("audit")}
                role="tab"
                type="button"
              >
                <Clock3 size={15} /> Activity
              </button>
            </>
          ) : null}
        </nav>

        {!secureTransport ? (
          <div className="account-transport-warning" role="alert">
            <AlertTriangle size={16} />
            <span>Connect over HTTPS before entering passwords or changing accounts.</span>
          </div>
        ) : null}
        {adminError ? <p className="account-panel-error" role="alert">{adminError}</p> : null}
        {accountError ? <p className="account-panel-error" role="alert">{accountError}</p> : null}
        {notice ? <p className="account-panel-notice" role="status">{notice}</p> : null}

        <div className="account-panel-content">
          {tab === "account" ? (
            <section className="account-overview" role="tabpanel">
              <div className="account-profile-card">
                <span className="account-avatar account-avatar-large" aria-hidden="true">
                  {initials(user.displayName)}
                </span>
                <div>
                  <h3>{user.displayName}</h3>
                  <p>{user.email}</p>
                  <span className="account-role-badge">
                    {user.role === "admin" ? "Administrator" : "Member"}
                  </span>
                </div>
              </div>
              <dl className="account-details">
                <div><dt>Account created</dt><dd>{readableDate(user.createdAt)}</dd></div>
                <div><dt>Last updated</dt><dd>{readableDate(user.updatedAt)}</dd></div>
                <div><dt>Storage</dt><dd>Backend disk, isolated by account</dd></div>
                <div><dt>Browser</dt><dd>Protected session cookie only</dd></div>
              </dl>
              <div className="account-security-copy">
                <KeyRound size={18} />
                <p>
                  Passwords are hashed by the backend and are never returned to this browser.
                  Changing yours rotates this session and signs out your other devices.
                </p>
              </div>
              <div className="account-self-service">
                <form className="account-self-form" onSubmit={saveProfile}>
                  <div>
                    <h3>Profile</h3>
                    <p>Choose the name shown throughout this workspace.</p>
                  </div>
                  <label>
                    <span>Display name</span>
                    <input
                      defaultValue={user.displayName}
                      disabled={!secureTransport || profileBusy}
                      maxLength={80}
                      name="displayName"
                      required
                      type="text"
                    />
                  </label>
                  <button
                    className="account-save-button"
                    disabled={!secureTransport || profileBusy}
                    type="submit"
                  >
                    {profileBusy ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}
                    {profileBusy ? "Saving…" : "Update profile"}
                  </button>
                </form>

                <form className="account-self-form" onSubmit={savePassword}>
                  <div>
                    <h3>Change password</h3>
                    <p>Use at least 12 characters and confirm the new password.</p>
                  </div>
                  <label>
                    <span>Current password</span>
                    <input
                      autoComplete="current-password"
                      disabled={!secureTransport || passwordBusy}
                      name="currentPassword"
                      required
                      type="password"
                    />
                  </label>
                  <div className="account-form-grid">
                    <label>
                      <span>New password</span>
                      <input
                        autoComplete="new-password"
                        disabled={!secureTransport || passwordBusy}
                        minLength={12}
                        name="newPassword"
                        required
                        type="password"
                      />
                    </label>
                    <label>
                      <span>Confirm password</span>
                      <input
                        autoComplete="new-password"
                        disabled={!secureTransport || passwordBusy}
                        minLength={12}
                        name="passwordConfirmation"
                        required
                        type="password"
                      />
                    </label>
                  </div>
                  <button
                    className="account-save-button"
                    disabled={!secureTransport || passwordBusy}
                    type="submit"
                  >
                    {passwordBusy ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}
                    {passwordBusy ? "Changing…" : "Change password"}
                  </button>
                </form>
              </div>
              <button
                className="account-logout-button"
                disabled={loggingOut}
                onClick={() => void signOut()}
                type="button"
              >
                {loggingOut ? <LoaderCircle className="spin" size={16} /> : <LogOut size={16} />}
                {loggingOut ? "Signing out…" : "Sign out"}
              </button>
            </section>
          ) : null}

          {tab === "users" && isAdmin ? (
            <section className="account-users" role="tabpanel">
              <form className="account-create-user" onSubmit={createUser}>
                <div className="account-section-heading">
                  <span><UserPlus size={17} /></span>
                  <div><h3>Add user</h3><p>Create a member or another administrator.</p></div>
                </div>
                <div className="account-form-grid">
                  <label><span>Display name</span><input disabled={!secureTransport || creating} maxLength={80} name="displayName" required type="text" /></label>
                  <label><span>Email</span><input autoComplete="off" disabled={!secureTransport || creating} maxLength={254} name="email" required type="email" /></label>
                  <label><span>Temporary password</span><input autoComplete="new-password" disabled={!secureTransport || creating} minLength={12} name="password" required type="password" /></label>
                  <label><span>Role</span><select defaultValue="member" disabled={!secureTransport || creating} name="role"><option value="member">Member</option><option value="admin">Administrator</option></select></label>
                </div>
                <button className="account-save-button" disabled={!secureTransport || creating} type="submit">
                  {creating ? <LoaderCircle className="spin" size={15} /> : <UserPlus size={15} />}
                  {creating ? "Creating…" : "Create user"}
                </button>
              </form>

              <div className="account-users-heading">
                <div><h3>Workspace users</h3><p>{users.length} account{users.length === 1 ? "" : "s"}</p></div>
                <button
                  aria-label="Reload users"
                  className="account-icon-button"
                  disabled={loadingAdmin}
                  onClick={() => void loadAdminData()}
                  type="button"
                >
                  <RefreshCw className={loadingAdmin ? "spin" : ""} size={16} />
                </button>
              </div>
              {loadingAdmin && users.length === 0 ? (
                <div className="account-empty"><LoaderCircle className="spin" size={20} /> Loading users…</div>
              ) : users.length === 0 ? (
                <div className="account-empty"><Ban size={20} /> No users were returned.</div>
              ) : (
                <div className="account-user-list">
                  {users.map((candidate) => (
                    <UserEditor
                      currentUserId={user.id}
                      disabled={!secureTransport}
                      key={`${candidate.id}:${candidate.updatedAt}:${candidate.disabled}`}
                      onRevokeSessions={revokeSessions}
                      onSave={saveUser}
                      user={candidate}
                    />
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {tab === "provider" && isAdmin ? (
            <section
              aria-busy={providerLoading}
              aria-live="polite"
              className="account-provider"
              role="tabpanel"
            >
              <div className="account-provider-heading">
                <div className="account-section-heading">
                  <span><Server size={17} /></span>
                  <div>
                    <h3>Higgsfield provider</h3>
                    <p>Read-only connection status from the backend server.</p>
                  </div>
                </div>
                <button
                  className="account-secondary-button"
                  disabled={providerLoading}
                  onClick={() => void loadProviderStatus()}
                  type="button"
                >
                  <RefreshCw className={providerLoading ? "spin" : ""} size={15} />
                  {providerLoading ? "Checking…" : "Recheck connection"}
                </button>
              </div>

              {providerError ? (
                <div className="account-provider-error" role="alert">
                  <AlertTriangle size={17} />
                  <div><strong>Status check failed</strong><p>{providerError}</p></div>
                </div>
              ) : null}

              {providerLoading && !providerStatus ? (
                <div className="account-empty">
                  <LoaderCircle className="spin" size={20} /> Checking Higgsfield…
                </div>
              ) : null}

              {providerStatus ? (
                <>
                  <div className={`account-provider-state ${providerConnected ? "is-connected" : "is-disconnected"}`}>
                    <span className="account-provider-state-icon">
                      {providerConnected ? <Wifi size={20} /> : <WifiOff size={20} />}
                    </span>
                    <div>
                      <span>HIGGSFIELD CLI</span>
                      <strong>{providerConnected ? "Connected" : "Disconnected"}</strong>
                      <p>
                        {providerConnected
                          ? "The backend is ready to run image and video generation."
                          : "Review the checks below, then authenticate on the backend server."}
                      </p>
                    </div>
                    <div className="account-provider-state-actions">
                      {providerStatus.mockMode ? (
                        <span className="account-provider-demo">Demo mode</span>
                      ) : null}
                      <button
                        className={providerConnected
                          ? "account-provider-guide-button"
                          : "account-provider-connect-button"}
                        onClick={revealProviderGuide}
                        type="button"
                      >
                        <Terminal size={14} />
                        {providerConnected ? "Show login guide" : "Connect Higgsfield"}
                      </button>
                    </div>
                  </div>

                  <dl className="account-provider-checks">
                    <div>
                      <dt><Terminal size={15} /> CLI installed</dt>
                      <dd className={providerStatus.cli.installed ? "is-ok" : "is-error"}>
                        {providerStatus.cli.installed ? "Installed" : "Not installed"}
                      </dd>
                    </div>
                    <div>
                      <dt><ShieldCheck size={15} /> Authentication</dt>
                      <dd className={providerStatus.cli.authenticated ? "is-ok" : "is-error"}>
                        {providerStatus.cli.authenticated ? "Signed in" : "Sign-in required"}
                      </dd>
                    </div>
                    <div>
                      <dt><Cpu size={15} /> CLI version</dt>
                      <dd>{providerStatus.cli.version ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt><HardDrive size={15} /> Backend storage</dt>
                      <dd className={providerStatus.storage.writable ? "is-ok" : "is-error"}>
                        {providerStatus.storage.writable ? "Writable" : "Not writable"}
                      </dd>
                    </div>
                  </dl>

                  <div className="account-provider-models">
                    <div className="account-section-heading">
                      <span><Cpu size={17} /></span>
                      <div><h3>Generation models</h3><p>Models reported by the backend adapter.</p></div>
                    </div>
                    <dl>
                      <div><dt>Image</dt><dd>{providerStatus.models.image}</dd></div>
                      <div><dt>Video</dt><dd>{providerStatus.models.video}</dd></div>
                    </dl>
                  </div>

                  {showProviderGuide ? (
                    <div
                      className="account-provider-command"
                      ref={providerGuideRef}
                      tabIndex={-1}
                    >
                      <div className="account-section-heading">
                        <span><Terminal size={17} /></span>
                        <div><h3>Connect from the backend server</h3><p>{providerStatus.connection.description}</p></div>
                      </div>
                      <ol className="account-provider-steps">
                        <li>
                          <span className="account-provider-step-number">1</span>
                          <div>
                            <h4>Open the SSH tunnel locally</h4>
                            <p>
                              Run this on your computer and keep the SSH session open. It forwards
                              the CLI callback on port {providerStatus.connection.callbackPort}.
                            </p>
                            <div className="account-command-box">
                              <code>{providerStatus.connection.tunnelCommand}</code>
                              <button
                                aria-label="Copy SSH tunnel command"
                                className="account-command-copy"
                                onClick={() => void copyProviderCommand(
                                  "tunnel",
                                  providerStatus.connection.tunnelCommand,
                                )}
                                type="button"
                              >
                                {copyState?.target === "tunnel" && copyState.status === "copied"
                                  ? <CheckCircle2 size={15} />
                                  : <Copy size={15} />}
                                {copyState?.target === "tunnel" && copyState.status === "copied"
                                  ? "Copied"
                                  : "Copy tunnel"}
                              </button>
                            </div>
                          </div>
                        </li>
                        <li>
                          <span className="account-provider-step-number">2</span>
                          <div>
                            <h4>Run the login command on the server</h4>
                            <p>
                              Run this in that SSH session. If Higgsfield prints an authorization
                              URL, copy it into your local browser to finish signing in.
                            </p>
                            <div className="account-command-box">
                              <code>{providerStatus.connection.command}</code>
                              <button
                                aria-label="Copy Higgsfield server login command"
                                className="account-command-copy"
                                onClick={() => void copyProviderCommand(
                                  "login",
                                  providerStatus.connection.command,
                                )}
                                type="button"
                              >
                                {copyState?.target === "login" && copyState.status === "copied"
                                  ? <CheckCircle2 size={15} />
                                  : <Copy size={15} />}
                                {copyState?.target === "login" && copyState.status === "copied"
                                  ? "Copied"
                                  : "Copy login"}
                              </button>
                            </div>
                          </div>
                        </li>
                        <li>
                          <span className="account-provider-step-number">3</span>
                          <div>
                            <h4>Confirm the connection</h4>
                            <p>After the CLI reports success, return here and check the backend again.</p>
                            <button
                              className="account-secondary-button"
                              disabled={providerLoading}
                              onClick={() => void loadProviderStatus()}
                              type="button"
                            >
                              <RefreshCw className={providerLoading ? "spin" : ""} size={15} />
                              {providerLoading ? "Checking…" : "Recheck connection"}
                            </button>
                          </div>
                        </li>
                      </ol>
                      <p className="account-provider-command-note">
                        These controls only copy text. OneTake never runs login commands in your browser.
                      </p>
                      {copyState?.status === "copied" ? (
                        <p className="account-copy-status" role="status">
                          {copyState.target === "tunnel" ? "Tunnel" : "Login"} command copied to the clipboard.
                        </p>
                      ) : copyState?.status === "error" ? (
                        <p className="account-inline-error" role="alert">
                          Copy was blocked by the browser. Select the command and copy it manually.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {tab === "audit" && isAdmin ? (
            <section className="account-audit" role="tabpanel">
              <div className="account-section-heading">
                <span><Clock3 size={17} /></span>
                <div><h3>Security activity</h3><p>The latest 50 sign-in and account-management events.</p></div>
              </div>
              {loadingAdmin && audit.length === 0 ? (
                <div className="account-empty"><LoaderCircle className="spin" size={20} /> Loading activity…</div>
              ) : audit.length === 0 ? (
                <div className="account-empty">No security activity yet.</div>
              ) : (
                <ol className="account-audit-list">
                  {audit.map((record) => {
                    const actor = record.actorUserId ? usersById.get(record.actorUserId) : undefined;
                    const target = record.targetUserId ? usersById.get(record.targetUserId) : undefined;
                    return (
                      <li key={record.id}>
                        <span className="account-audit-dot" />
                        <div>
                          <strong>{actionLabel(record.action)}</strong>
                          <p>
                            {actor ? actor.displayName : record.actorUserId ? "Unknown user" : "System"}
                            {target && target.id !== actor?.id ? ` · ${target.displayName}` : ""}
                          </p>
                        </div>
                        <time dateTime={record.occurredAt}>{readableDate(record.occurredAt)}</time>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
