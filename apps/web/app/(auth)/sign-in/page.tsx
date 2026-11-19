"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import { trackOnce } from "@/lib/analytics";
import { suggestEmail } from "@/lib/emailTypo";

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
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [next, setNext] = useState("/");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(safeNext(params.get("next")));
    // The auth callback bounces here with ?error=auth when a link is invalid
    // or expired — say so instead of showing a pristine form.
    if (params.get("error") === "auth") {
      setError("That sign-in link didn't work — it may have expired. Enter your email for a fresh code.");
    }
  }, []);

  // Never show a raw auth error. When our email provider was down, the server
  // answered 500 and the auth library's message was the literal string "{}" —
  // which is what every new visitor saw for nine weeks, with no idea whether
  // to retry, wait, or give up. Say what happened and give them a way in.
  function sendCodeMessage(err: { message?: string; status?: number }): string {
    if (err.status === 429) {
      return "Too many attempts in a short time — give it a minute and try again.";
    }
    const m = (err.message ?? "").trim();
    const unreadable = !m || m === "{}" || m.startsWith("{") || (err.status ?? 0) >= 500;
    if (unreadable) {
      return "We couldn't send your code — that's a problem on our side, not yours. Try again in a few minutes, or email hello@prelogue.studio and we'll get you in.";
    }
    return m;
  }

  async function requestCode(address: string) {
    setLoading(true);
    setError(null);
    const { error } = await getBrowserClient().auth.signInWithOtp({
      email: address,
      options: { shouldCreateUser: true },
    });
    setLoading(false);
    if (error) {
      setError(sendCodeMessage(error));
      return;
    }
    setSuggestion(null);
    setEmail(address);
    setStep("code");
  }

  function sendCode(e: React.FormEvent) {
    e.preventDefault();
    const typed = email.trim();
    // A mistyped domain sends the code nowhere, and the visitor waits for an
    // email that can't arrive. Ask first — the choice stays theirs, because
    // real domains do sit one letter away from famous ones.
    const meant = suggestEmail(typed);
    if (meant) {
      setError(null);
      setSuggestion(meant);
      return;
    }
    void requestCode(typed);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error } = await getBrowserClient().auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    // Ad attribution: count a signup once per account, not on every sign-in.
    const u = data?.user;
    if (u?.id) trackOnce(`reg:${u.id}`, "CompleteRegistration");
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
              onChange={(e) => {
                setEmail(e.target.value);
                setSuggestion(null);
              }}
              className={input}
            />
          </label>
          {suggestion ? (
            <div role="status" className="rounded-lg border border-tan bg-elevated px-4 py-3">
              <p className="text-sm text-taupe">
                Did you mean <strong className="break-words text-ink">{suggestion}</strong>?
              </p>
              <button
                type="button"
                disabled={loading}
                onClick={() => requestCode(suggestion)}
                className="mt-3 w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
              >
                {loading ? "Sending…" : "Yes, send my code there"}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => requestCode(email.trim())}
                className="mt-1 w-full break-words px-4 py-2 text-sm text-taupe underline hover:text-ink disabled:opacity-60"
              >
                No, {email.trim()} is right
              </button>
            </div>
          ) : (
            <button
              disabled={loading}
              className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
            >
              {loading ? "Sending…" : "Email me a code"}
            </button>
          )}
          <p className="text-center text-xs text-muted">
            We&rsquo;ll email you a 6-digit code — no password needed.
          </p>
          <p className="text-center text-xs text-muted">
            By continuing you agree to our{" "}
            <a href="/terms" className="underline hover:text-brick">
              Terms
            </a>{" "}
            and{" "}
            <a href="/privacy" className="underline hover:text-brick">
              Privacy Policy
            </a>
            .
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
            <button
              type="button"
              onClick={() => requestCode(email.trim())}
              className="text-taupe hover:text-ink"
            >
              Resend code
            </button>
          </div>
        </form>
      )}
    </>
  );
}
