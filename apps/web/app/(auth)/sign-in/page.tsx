"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";

// Only allow same-origin relative redirects (no open-redirect to other sites).
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-3 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

export default function SignInPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [next, setNext] = useState("/");

  useEffect(() => {
    setNext(safeNext(new URLSearchParams(window.location.search).get("next")));
  }, []);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await getBrowserClient().auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setStep("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await getBrowserClient().auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <>
      <h1 className="font-slab text-2xl">
        {step === "email" ? "Sign in or sign up" : "Enter your code"}
      </h1>
      {next.startsWith("/record") && step === "email" && (
        <p className="mt-2 text-sm text-taupe">Sign in to record your read.</p>
      )}

      {step === "email" ? (
        <form onSubmit={sendCode} className="mt-6 flex flex-col gap-4">
          {error && <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}
          <label className="flex flex-col gap-1">
            <span className={label}>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={input}
            />
          </label>
          <button
            disabled={loading}
            className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
          >
            {loading ? "Sending…" : "Email me a code"}
          </button>
          <p className="text-center text-xs text-muted">
            We&rsquo;ll email you a 6-digit code — no password needed.
          </p>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-6 flex flex-col gap-4">
          {error && <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}
          <p className="text-sm text-taupe">
            We sent a 6-digit code to <strong className="text-ink">{email}</strong>.
          </p>
          <label className="flex flex-col gap-1">
            <span className={label}>6-digit code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
              className={`${input} text-center text-2xl tracking-[0.5em]`}
            />
          </label>
          <button
            disabled={loading || code.length < 6}
            className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
          >
            {loading ? "Verifying…" : "Verify & continue"}
          </button>
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
              className="text-taupe hover:text-ink"
            >
              ← Use a different email
            </button>
            <button type="button" onClick={sendCode} className="text-taupe hover:text-ink">
              Resend code
            </button>
          </div>
        </form>
      )}
    </>
  );
}
