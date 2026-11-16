/**
 * Settings -> "AI admin login" (Kyle, 2026-11-15: "Lets do a username and password so it can save
 * it and login on its own"; "Its own login" - his PIN keeps working for him; "No cap" on renewal).
 *
 * One login, for the AI admin only. Save login creates it or changes its password; Turn off /
 * Turn on switch it; Remove login deletes it (the standing "nothing permanent" rule). Saving, Turn
 * off and Remove all end the AI admin's session at once - the server refuses its token on its next
 * request. Kyle's PIN session is never touched. The password is never shown back; the server keeps
 * only a hash.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AdminLoginStatus } from "../lib/types";

const PASSWORD_MIN = 12;
const USERNAME_MIN = 3;
const SIGNED_OUT = "The AI admin is signed out and will have to sign in again on its next click.";

export function AdminLoginSection() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: ["adminLogin"], queryFn: () => api.adminLogin() });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Show the saved username in its box (the password is never sent back, so it stays empty).
  useEffect(() => {
    if (status?.username) setUsername(status.username);
  }, [status?.username]);

  const configured = status?.configured === true;
  const enabled = status?.enabled === true;

  const done = (message: string) => (next: AdminLoginStatus) => {
    queryClient.setQueryData(["adminLogin"], next);
    setNotice(message);
    setError(null);
  };
  const failed = (e: Error) => {
    setNotice(null);
    setError(e.message);
  };

  const saveMutation = useMutation({
    mutationFn: () => api.saveAdminLogin({ username: username.trim(), password }),
    onSuccess: (next) => {
      setPassword("");
      done(`Login saved. ${SIGNED_OUT}`)(next);
    },
    onError: failed,
  });
  const offMutation = useMutation({
    mutationFn: () => api.turnOffAdminLogin(),
    onSuccess: done(`Login turned off. ${SIGNED_OUT}`),
    onError: failed,
  });
  const onMutation = useMutation({
    mutationFn: () => api.turnOnAdminLogin(),
    onSuccess: done("Login turned on. The AI admin can sign in again."),
    onError: failed,
  });
  const removeMutation = useMutation({
    mutationFn: () => api.removeAdminLogin(),
    onSuccess: (next) => {
      setUsername("");
      setPassword("");
      done(`Login removed. ${SIGNED_OUT}`)(next);
    },
    onError: failed,
  });

  const busy = saveMutation.isPending || offMutation.isPending || onMutation.isPending || removeMutation.isPending;

  // Why Save login is unavailable, said on the screen rather than just greying the button.
  const saveReason: string | null =
    username.trim().length < USERNAME_MIN ? `Type a username (at least ${USERNAME_MIN} characters).`
      : password.length === 0 ? (configured ? "Type a new password to change it." : "Type a password.")
        : password.length < PASSWORD_MIN ? `The password needs at least ${PASSWORD_MIN} characters (${password.length} so far).`
          : null;

  const statusText = isLoading ? "Loading…"
    : !configured ? "Not set up — the AI admin cannot sign in yet."
      : enabled ? `On — the AI admin signs in as "${status?.username}".`
        : `Off — the AI admin cannot sign in as "${status?.username}" until you turn it on.`;

  return (
    <section className="card mt-5 p-6" aria-label="AI admin login">
      <h2 className="text-lg font-semibold">AI admin login</h2>
      <p className="mt-1 text-sm text-rce-muted">
        The AI admin's own sign-in, separate from your PIN (Kyle, 2026-11-15: "Its own login"). Your PIN keeps working
        for you. The AI admin uses this username and password on the sign-in page, and stays signed in while it is in use.
      </p>

      <p
        className={`mt-4 text-sm font-semibold ${configured && enabled ? "text-green-800" : "text-rce-muted"}`}
        data-testid="admin-login-status"
      >
        {statusText}
      </p>

      <form
        method="post"
        className="mt-4 grid gap-3 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!saveReason && !busy) saveMutation.mutate();
        }}
      >
        <label className="text-sm font-medium">
          Username
          <input
            className="field mt-1 w-full"
            type="text"
            name="ai-admin-username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="text-sm font-medium">
          Password
          <input
            className="field mt-1 w-full"
            type="password"
            name="ai-admin-password"
            autoComplete="new-password"
            value={password}
            placeholder={configured ? "Type a new password to change it" : ""}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="md:col-span-2">
          <button className="btn btn-primary" type="submit" disabled={busy || saveReason !== null}>
            Save login
          </button>
          {saveReason && (
            <span className="ml-3 text-xs text-rce-muted" data-testid="admin-login-save-reason">{saveReason}</span>
          )}
        </div>
      </form>
      <p className="mt-2 text-xs text-rce-muted">
        The password is stored only as a hash and is never shown again. Saving a login signs the AI admin out at once.
      </p>

      {configured && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-rce-border pt-4">
          {enabled ? (
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => offMutation.mutate()}>
              Turn off
            </button>
          ) : (
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => onMutation.mutate()}>
              Turn on
            </button>
          )}
          <button
            className="btn btn-danger"
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Remove the AI admin login? It is signed out and cannot sign in again until you set a new login.")) {
                removeMutation.mutate();
              }
            }}
          >
            Remove login
          </button>
        </div>
      )}

      {notice && <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">{notice}</p>}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}
    </section>
  );
}
