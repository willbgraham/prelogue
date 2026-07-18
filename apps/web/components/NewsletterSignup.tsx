"use client";

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

/** Footer email capture — stores addresses in the subscribers table. */
export function NewsletterSignup() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      setStatus("error");
      setMsg("Please enter a valid email.");
      return;
    }
    setStatus("loading");
    setMsg("");
    const { error } = await getBrowserClient().from("subscribers").insert({ email: value, source: "footer" });
    // 23505 = already subscribed → still a success from the reader's point of view.
    if (error && error.code !== "23505") {
      setStatus("error");
      setMsg("Something went wrong - please try again.");
      return;
    }
    setStatus("done");
    setMsg(error?.code === "23505" ? "You're already on the list - thanks!" : "You're on the list! 🎬");
    setEmail("");
  }

  if (status === "done") {
    return <p className="text-sm font-medium text-brick">{msg}</p>;
  }

  return (
    <form onSubmit={submit} className="w-full sm:w-auto">
      <div className="flex w-full gap-2 sm:w-80">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
          aria-label="Email address"
          className="min-w-0 flex-1 rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="shrink-0 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {status === "loading" ? "…" : "Subscribe"}
        </button>
      </div>
      {status === "error" && <p className="mt-1 text-xs text-brick">{msg}</p>}
    </form>
  );
}
