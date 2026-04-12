import { useState, useRef, useEffect, type FormEvent } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  visitId: string;
  propertyId?: string;
}

export function EstimateIntake({ visitId, propertyId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const token = localStorage.getItem("rce_token") ?? "";

  // Initialize session on mount
  useEffect(() => {
    async function init() {
      try {
        const res = await fetch("/api/chatkit/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ visitId, propertyId }),
        });
        if (!res.ok) throw new Error("Failed to create session");
        const data = (await res.json()) as { sessionId: string };
        setSessionId(data.sessionId);
      } catch {
        setError("Could not connect to AI agent. Check configuration.");
      }
    }
    init();
  }, [visitId, propertyId, token]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !sessionId || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chatkit/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId, message: text, visitId }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(errData?.error ?? "Send failed");
      }

      const data = (await res.json()) as { reply: string };
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: msg },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col" style={{ height: "calc(100vh - 340px)", minHeight: 320 }}>
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-rce-success" />
        <h2 className="text-base font-semibold text-rce-text">AI Estimate Assistant</h2>
        <span className="text-xs text-rce-muted">powered by GPT-4.1</span>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-rce-danger/30 bg-red-50 p-3 text-sm text-rce-danger">
          {error}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-rce-border bg-rce-bg p-3 space-y-3">
        {messages.length === 0 && !error && (
          <div className="flex h-full items-center justify-center text-sm text-rce-muted">
            <div className="max-w-xs text-center space-y-2">
              <p className="font-medium text-rce-text">Ready to estimate</p>
              <p>Describe the work needed and I'll build the estimate using the 82-unit catalog.</p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-rce-accent text-white"
                  : "border border-rce-border bg-white text-rce-text"
              }`}
            >
              {msg.content.split("\n").map((line, j) => (
                <p key={j} className={j > 0 ? "mt-1" : ""}>
                  {line}
                </p>
              ))}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="rounded-xl border border-rce-border bg-white px-3 py-2 text-sm text-rce-muted">
              <span className="animate-pulse">Thinking…</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="mt-3 flex gap-2">
        <input
          type="text"
          className="field flex-1"
          placeholder="Describe the electrical work…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading || !sessionId}
        />
        <button
          type="submit"
          disabled={!input.trim() || loading || !sessionId}
          className="btn btn-primary disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}
