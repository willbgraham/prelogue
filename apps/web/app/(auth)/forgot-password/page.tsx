"use client";

import { useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-3 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await getBrowserClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <>
        <h1 className="font-slab text-2xl">Check your email</h1>
        <p className="mt-3 text-taupe">
          If an account exists for <span className="text-ink">{email}</span>, you&rsquo;ll get a
          link to reset your password.
        </p>
        <Link href="/sign-in" className="mt-4 inline-block text-sm text-ink hover:underline">
          Back to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="font-slab text-2xl">Reset your password</h1>
      <p className="mt-2 text-sm text-taupe">We&rsquo;ll email you a reset link.</p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        {error && (
          <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>
        )}
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
          {loading ? "Sending…" : "Send reset link"}
        </button>
      </form>
      <Link href="/sign-in" className="mt-4 inline-block text-sm text-taupe hover:text-ink">
        Back to sign in
      </Link>
    </>
  );
}
