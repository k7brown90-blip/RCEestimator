import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function PinLoginPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [credError, setCredError] = useState("");
  const [credLoading, setCredLoading] = useState(false);
  const navigate = useNavigate();
  // PUNCHLIST C5: `RequireAuth` (App.tsx) hands the page it bounced FROM as
  // `state.from` — a bookmarked or shared link should return the operator to
  // it, not always to Jobs. No `from` (a plain visit to /login) still lands
  // on "/", the one home `/` -> /dashboard already redirects to.
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string; search: string; hash: string } } | null)?.from;
  const redirectTo = from ? `${from.pathname}${from.search}${from.hash}` : "/";

  // POST a credential to a login route, store the token and go where the operator was headed.
  // Returns the message to show when it is refused, or "" on success. The credential travels in the
  // JSON body only — never a URL.
  async function signIn(url: string, payload: Record<string, string>): Promise<string> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        return body.error ?? "Login failed";
      }

      const { token } = (await res.json()) as { token: string };
      localStorage.setItem("rce_token", token);
      navigate(redirectTo, { replace: true });
      return "";
    } catch {
      return "Connection failed";
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read the PIN from the form itself, not from React state: a browser secure-fill or a paste
    // that sets the box's value without key events never reaches onChange, so state would still
    // be empty and the fill would "submit" nothing.
    const pin = String(new FormData(e.currentTarget).get("pin") ?? "").replace(/\D/g, "");
    setError("");
    setLoading(true);
    try {
      setError(await signIn("/api/auth/pin", { pin }));
    } finally {
      setLoading(false);
    }
  }

  // The AI admin's own login (Kyle, 2026-11-15). Same rule as the PIN: read the boxes from the form,
  // not from state, so a password manager's secure fill (no key events) still submits.
  async function handleCredentialSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const username = String(data.get("username") ?? "");
    const password = String(data.get("password") ?? "");
    setCredError("");
    setCredLoading(true);
    try {
      setCredError(await signIn("/api/auth/login", { username, password }));
    } finally {
      setCredLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-rce-bg">
      <div className="card mx-4 w-full max-w-sm space-y-5 p-6 text-center">
        <div className="rounded-xl border border-white/10 bg-rce-navBg px-3 py-3 text-sm font-semibold tracking-[0.08em] text-rce-navText shadow-card">
          RCE ESTIMATING
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <h1 className="text-lg font-semibold text-rce-text">Enter PIN</h1>

          <input
            id="pin"
            name="pin"
            type="password"
            autoComplete="current-password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoFocus
            aria-label="PIN"
            className="field mx-auto max-w-[160px] text-center text-2xl tracking-[0.3em]"
            onChange={(e) => {
              e.target.value = e.target.value.replace(/\D/g, "");
            }}
            placeholder="••••"
          />

          {error && (
            <p className="text-sm font-medium text-rce-danger">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary w-full disabled:opacity-40"
          >
            {loading ? "Verifying…" : "Unlock"}
          </button>
        </form>

        {/* The AI admin's own sign-in (Kyle, 2026-11-15). A separate form with real, visible
            Username and Password boxes, so a password manager finds and fills them. method="post"
            so that if the script ever failed to load, the browser would not put the credentials in
            the address bar (the default for a form is GET). */}
        <form
          method="post"
          onSubmit={handleCredentialSubmit}
          className="space-y-3 border-t border-rce-border pt-5 text-left"
        >
          <h2 className="text-center text-sm font-semibold text-rce-text">
            Sign in with username and password
          </h2>

          <label className="block text-xs font-medium text-rce-muted">
            Username
            <input
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className="field mt-1 w-full"
            />
          </label>

          <label className="block text-xs font-medium text-rce-muted">
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              className="field mt-1 w-full"
            />
          </label>

          {credError && (
            <p className="text-center text-sm font-medium text-rce-danger">{credError}</p>
          )}

          <button
            type="submit"
            disabled={credLoading}
            className="btn btn-secondary w-full disabled:opacity-40"
          >
            {credLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
