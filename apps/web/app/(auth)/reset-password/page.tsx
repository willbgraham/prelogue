"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-3 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    setError(null);
    // The recovery code was exchanged for a session at /auth/callback, so the
    // user is authenticated here and can set a new password.
    const { error } = await getBrowserClient().auth.updateUser({ password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <>
      <h1 className="font-slab text-2xl">Set a new password</h1>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        {error && (
          <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>
        )}
        <label className="flex flex-col gap-1">
          <span className={label}>New password</span>
          <input
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Confirm password</span>
          <input
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={input}
          />
        </label>
        <button
          disabled={loading}
          className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
        >
          {loading ? "Saving…" : "Update password"}
        </button>
      </form>
    </>
  );
}
