import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

export function PinLoginPage() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? "Login failed");
        return;
      }

      const { token } = (await res.json()) as { token: string };
      localStorage.setItem("rce_token", token);
      navigate("/jobs", { replace: true });
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-rce-bg">
      <form
        onSubmit={handleSubmit}
        className="card mx-4 w-full max-w-sm space-y-5 p-6 text-center"
      >
        <div className="rounded-xl border border-white/10 bg-rce-navBg px-3 py-3 text-sm font-semibold tracking-[0.08em] text-rce-navText shadow-card">
          RCE ESTIMATING
        </div>

        <h1 className="text-lg font-semibold text-rce-text">Enter PIN</h1>

        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoFocus
          className="field mx-auto max-w-[160px] text-center text-2xl tracking-[0.3em]"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder="••••"
        />

        {error && (
          <p className="text-sm font-medium text-rce-danger">{error}</p>
        )}

        <button
          type="submit"
          disabled={pin.length < 4 || loading}
          className="btn btn-primary w-full disabled:opacity-40"
        >
          {loading ? "Verifying…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
