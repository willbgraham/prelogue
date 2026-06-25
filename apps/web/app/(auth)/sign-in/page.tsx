"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-3 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await getBrowserClient().auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    const next = new URLSearchParams(window.location.search).get("next") || "/";
    router.push(next);
    router.refresh();
  }

  return (
    <>
      <h1 className="font-slab text-2xl">Welcome back</h1>
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
        <label className="flex flex-col gap-1">
          <span className={label}>Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={input}
          />
        </label>
        <button
          disabled={loading}
          className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <div className="mt-4 flex justify-between text-sm text-taupe">
        <Link href="/forgot-password" className="hover:text-ink">
          Forgot password?
        </Link>
        <Link href="/sign-up" className="hover:text-ink">
          Create account
        </Link>
      </div>
    </>
  );
}
