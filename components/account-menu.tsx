"use client";

import { ChevronDown, Settings2 } from "lucide-react";
import { useState } from "react";

import { AccountPanel } from "@/components/account-panel";
import { useAuth } from "@/components/auth-provider";

function initials(name: string) {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : name.slice(0, 2))
    .toUpperCase();
}

export function AccountMenu({ className = "" }: { className?: string }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Account settings for ${user.displayName}`}
        className={`account-menu-trigger ${className}`.trim()}
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="account-avatar" aria-hidden="true">{initials(user.displayName)}</span>
        <span className="account-menu-copy">
          <strong>{user.displayName}</strong>
          <small>{user.role === "admin" ? "Administrator" : "Member"}</small>
        </span>
        <Settings2 aria-hidden="true" className="account-menu-settings" size={15} />
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open ? <AccountPanel onClose={() => setOpen(false)} open /> : null}
    </>
  );
}
