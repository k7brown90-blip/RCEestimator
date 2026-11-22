/**
 * Team -> "CRM login" (work order agent-team, HA4). Kyle gives a team member their own username and
 * password for the CRM, picks the role, and grants the Kyle-only powers one by one. ONE dialog with
 * two doors: the "CRM login" button on a Team roster row, and the "CRM login" card on that person's
 * own page (/team/:technicianId).
 *
 * The form and the notices copy pages/AdminLoginSection.tsx (the AI admin's login): Save login
 * creates the login or changes it; Turn off / Turn on switch it; Remove login deletes it (the
 * standing "nothing permanent" rule). A password change, Turn off and Remove end that person's
 * session at once - the server refuses their token on their next click. The password is never shown
 * back; the server keeps only a hash. Leaving the password blank keeps the current one.
 *
 * Every Kyle-only power is a checkbox that saves the moment it is ticked (so Kyle sees the grant
 * land, and a revoke is one click). Kyle's own login holds every power, so its boxes show ticked and
 * locked. The "This is me" box exists only for Kyle's PIN session: only the PIN can say which login
 * is Kyle's.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CrmLoginView } from "../lib/types";
import { roleLabel, SESSION_QUERY_KEY, useIsKyle, useSession } from "../lib/session";
import { Modal } from "./Modal";
import { CRM_POWERS, CRM_POWER_KEYS, CRM_ROLES, type CrmPower } from "../../../shared/crmPowers";

export const CRM_LOGINS_QUERY_KEY = ["crmLogins"] as const;

const PASSWORD_MIN = 12;
const USERNAME_MIN = 3;
const TECH_NOTE = "Tech logins can't sign in to the CRM yet.";

type LoginList = { logins: CrmLoginView[] };

/** The list as the dialog and the roster read it. Only a session that is (or may be) Kyle asks. */
export function useCrmLogins(enabled = true) {
  return useQuery({ queryKey: CRM_LOGINS_QUERY_KEY, queryFn: () => api.crmLogins(), enabled });
}

/**
 * Why this login, though turned on, cannot actually sign in - or null when it can. The same three
 * refusals the sign-in door makes: a Tech role (no CRM sign-in yet), a person deactivated on the
 * roster, and no password set. Kyle's own (principal) login with no password CAN sign in: the owner
 * PIN signs in as that person.
 */
export function cannotSignInReason(login: CrmLoginView): string | null {
  if (login.role === "tech") return "Tech logins can't sign in to the CRM yet";
  if (!login.personActive) return "they are deactivated on the Team roster";
  if (!login.hasPassword && !login.isPrincipal) return "no password is set";
  return null;
}

/** The roster tag: "CRM: Owner · on", "CRM: Office · off", "CRM: Tech · on, can't sign in", or null for no login. */
export function crmLoginTag(login: CrmLoginView | undefined): string | null {
  if (!login) return null;
  const base = `CRM: ${roleLabel(login.role)} · ${login.enabled ? "on" : "off"}`;
  return login.enabled && cannotSignInReason(login) ? `${base}, can't sign in` : base;
}

export const CRM_LOGIN_ONLY_KYLE = "Only Kyle manages CRM logins.";

/**
 * The "CRM login" button, used by BOTH doors (a Team roster row, and the card on a person's own
 * page): it owns the open state and the dialog, so the two places cannot drift. For a session that
 * is not Kyle it is greyed WITH the reason beside it, never hidden.
 */
export function CrmLoginButton({ technician, className = "btn btn-secondary px-2 py-0.5 text-xs min-h-0" }: {
  technician: { id: string; name: string };
  className?: string;
}) {
  const isKyle = useIsKyle();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={!isKyle}
        title={isKyle ? undefined : CRM_LOGIN_ONLY_KYLE}
        onClick={() => setOpen(true)}
      >
        CRM login
      </button>
      {!isKyle && <span className="text-xs text-rce-muted" data-testid="crm-login-only-kyle">{CRM_LOGIN_ONLY_KYLE}</span>}
      {open && isKyle && <CrmLoginDialog technician={technician} onClose={() => setOpen(false)} />}
    </>
  );
}

export function CrmLoginDialog({ technician, onClose }: { technician: { id: string; name: string }; onClose: () => void }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const { data, isLoading } = useCrmLogins();
  const login = data?.logins.find((l) => l.technicianId === technician.id) ?? null;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>("owner");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Show the saved username and role in their boxes (the password is never sent back).
  useEffect(() => {
    if (login) {
      setUsername(login.username);
      setRole(login.role);
    }
  }, [login?.id, login?.username, login?.role]);

  const store = (next: CrmLoginView) => {
    queryClient.setQueryData<LoginList>(CRM_LOGINS_QUERY_KEY, (old) => {
      const others = (old?.logins ?? []).filter((l) => l.technicianId !== next.technicianId);
      // A principal mark moves: only one login carries it.
      const cleared = next.isPrincipal ? others.map((l) => ({ ...l, isPrincipal: false })) : others;
      return { logins: [...cleared, next].sort((a, b) => a.name.localeCompare(b.name)) };
    });
    // The signed-in person's own role or powers may have just changed.
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };
  const done = (message: string) => (next: CrmLoginView) => {
    store(next);
    setNotice(message);
    setError(null);
  };
  const failed = (e: Error) => {
    setNotice(null);
    setError(e.message);
  };

  const saveMutation = useMutation({
    mutationFn: () => api.saveCrmLogin(technician.id, {
      username: username.trim(),
      role,
      ...(password !== "" ? { password } : {}),
    }),
    onSuccess: (next) => {
      const changedPassword = password !== "";
      setPassword("");
      done(changedPassword
        ? `Login saved. ${technician.name} is signed out and signs in again with the new password.`
        : "Login saved.")(next);
    },
    onError: failed,
  });
  const offMutation = useMutation({
    mutationFn: () => api.turnOffCrmLogin(technician.id),
    onSuccess: done(`Login turned off. ${technician.name} is signed out at once.`),
    onError: failed,
  });
  const onMutation = useMutation({
    mutationFn: () => api.turnOnCrmLogin(technician.id),
    onSuccess: done(`Login turned on. ${technician.name} can sign in again.`),
    onError: failed,
  });
  const removeMutation = useMutation({
    mutationFn: () => api.removeCrmLogin(technician.id),
    onSuccess: () => {
      queryClient.setQueryData<LoginList>(CRM_LOGINS_QUERY_KEY, (old) => ({
        logins: (old?.logins ?? []).filter((l) => l.technicianId !== technician.id),
      }));
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      setUsername("");
      setPassword("");
      setRole("owner");
      setNotice(`Login removed. ${technician.name} is signed out at once.`);
      setError(null);
    },
    onError: failed,
  });
  const powersMutation = useMutation({
    mutationFn: (powers: CrmPower[]) => api.setCrmLoginPowers(technician.id, powers),
    onSuccess: done("Powers saved. They apply on the person's next click."),
    onError: failed,
  });
  const principalMutation = useMutation({
    mutationFn: (principal: boolean) => api.setCrmLoginPrincipal(technician.id, principal),
    onSuccess: (next) => done(next.isPrincipal
      ? `${technician.name}'s login is marked as yours. The owner PIN now signs in as ${technician.name}.`
      : "That login is no longer marked as yours.")(next),
    onError: failed,
  });

  const busy = saveMutation.isPending || offMutation.isPending || onMutation.isPending
    || removeMutation.isPending || powersMutation.isPending || principalMutation.isPending;

  // Why Save login is unavailable, said on the screen rather than just greying the button.
  const saveReason: string | null =
    username.trim().length < USERNAME_MIN ? `Type a username (at least ${USERNAME_MIN} characters).`
      : password !== "" && password.length < PASSWORD_MIN
        ? `The password needs at least ${PASSWORD_MIN} characters (${password.length} so far).`
        : null;

  const blocked = login ? cannotSignInReason(login) : null;
  const statusText = isLoading ? "Loading…"
    : !login ? `No CRM login yet for ${technician.name}.`
      : !login.enabled ? `Off — ${technician.name} cannot sign in as "${login.username}" until you turn it on.`
        : blocked ? `On, but ${technician.name} can't sign in yet: ${blocked}.`
          : `On — ${technician.name} signs in as "${login.username}" (${roleLabel(login.role)}).`;

  const isPin = session?.kind === "kyle-pin";
  const heldPowers = login ? (login.isPrincipal ? [...CRM_POWER_KEYS] : login.powers) : [];

  const togglePower = (power: CrmPower, on: boolean) => {
    const next = on ? [...heldPowers, power] : heldPowers.filter((p) => p !== power);
    powersMutation.mutate(CRM_POWER_KEYS.filter((k) => next.includes(k)));
  };

  return (
    <Modal title={`CRM login for ${technician.name}`} onClose={onClose}>
      <p
        className={`text-sm font-semibold ${login?.enabled && !blocked ? "text-green-800" : "text-rce-muted"}`}
        data-testid="crm-login-status"
      >
        {statusText}
      </p>

      <form
        method="post"
        className="mt-3 grid gap-3"
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
            name="crm-login-username"
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
            name="crm-login-password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="mt-1 block text-xs font-normal text-rce-muted">
            {login?.hasPassword
              ? "Leave blank to keep the current one."
              : "No password is set yet. Type one so this person can sign in."}
            {login?.isPrincipal && !login.hasPassword ? " (This is your own login: the owner PIN signs in as this person, so a password is optional.)" : ""}
            {" "}At least {PASSWORD_MIN} characters when you type one.
          </span>
        </label>
        <label className="text-sm font-medium">
          Role
          <select className="field mt-1 w-full" name="crm-login-role" value={role} onChange={(e) => setRole(e.target.value)}>
            {CRM_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </label>
        {role === "tech" && (
          <p
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            data-testid="crm-login-tech-note"
          >
            {TECH_NOTE}
          </p>
        )}
        <div>
          <button className="btn btn-primary" type="submit" disabled={busy || saveReason !== null}>
            Save login
          </button>
          {saveReason && (
            <span className="ml-3 text-xs text-rce-muted" data-testid="crm-login-save-reason">{saveReason}</span>
          )}
        </div>
      </form>
      <p className="mt-2 text-xs text-rce-muted">
        The password is stored only as a hash and is never shown again. Changing it signs {technician.name} out at once.
        The role decides which screens open; the powers below are separate and Kyle-only.
      </p>

      <fieldset className="mt-4 border-t border-rce-border pt-3" aria-label="Kyle-only powers">
        <legend className="pr-2 text-sm font-semibold">Kyle-only powers</legend>
        {!login ? (
          <p className="text-xs text-rce-muted" data-testid="crm-login-powers-reason">Save the login first, then grant powers.</p>
        ) : login.isPrincipal ? (
          <p className="mb-2 text-xs text-rce-muted" data-testid="crm-login-powers-reason">
            This is your own login, so it holds every power.
          </p>
        ) : (
          <p className="mb-2 text-xs text-rce-muted">Tick a power to grant it. It saves at once and applies on their next click.</p>
        )}
        <div className="grid gap-1.5">
          {CRM_POWER_KEYS.map((power) => (
            <label key={power} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={heldPowers.includes(power)}
                disabled={!login || login.isPrincipal || busy}
                onChange={(e) => togglePower(power, e.target.checked)}
              />
              {CRM_POWERS[power].label}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Always shown, so Kyle on his own login can see it exists; only the PIN can move the mark. */}
      <div className="mt-4 border-t border-rce-border pt-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={login?.isPrincipal === true}
            disabled={!isPin || !login || busy}
            onChange={(e) => principalMutation.mutate(e.target.checked)}
          />
          <span>This is me — the owner PIN signs in as this person</span>
        </label>
        {!isPin ? (
          <p className="ml-6 text-xs text-rce-muted" data-testid="crm-login-me-reason">
            Only the owner PIN can choose which login is yours. Sign in with the PIN to change this.
          </p>
        ) : !login ? (
          <p className="ml-6 text-xs text-rce-muted">Save the login first.</p>
        ) : null}
      </div>

      {login && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-rce-border pt-4">
          {login.enabled ? (
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
              if (window.confirm(`Remove ${technician.name}'s CRM login? ${technician.name} is signed out at once and cannot sign in again until you set a new login.`)) {
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
    </Modal>
  );
}
