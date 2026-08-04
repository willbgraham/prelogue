"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-2.5 text-sm outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

const TOPICS = [
  { key: "question", label: "A question" },
  { key: "feedback", label: "Feedback" },
  { key: "bug", label: "Something's broken" },
  { key: "billing", label: "Billing" },
  { key: "other", label: "Something else" },
];

export default function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("question");
  const [message, setMessage] = useState("");
  const [company, setCompany] = useState(""); // honeypot — real people leave this empty
  const [userId, setUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill from the signed-in profile so writers don't retype it.
  useEffect(() => {
    (async () => {
      const supabase = getBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);
      setEmail((e) => e || user.email || "");
      const { data } = await supabase
        .from("users")
        .select("display_name")
        .eq("id", user.id)
        .single();
      if (data?.display_name) setName((n) => n || data.display_name);
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (company) return; // bot
    const nm = name.trim();
    const em = email.trim();
    const msg = message.trim();
    if (!nm || !msg) {
      setError("Please add your name and a message.");
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
      setError("Please enter a valid email so we can reply.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: insErr } = await getBrowserClient()
      .from("contact_messages")
      .insert({ name: nm, email: em, topic, message: msg, user_id: userId });
    setBusy(false);
    if (insErr) {
      setError("Couldn't send that — please email hello@prelogue.studio instead.");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-16">
        <div className="rounded-xl border border-tan bg-ivory p-8 text-center">
          <div className="font-slab text-2xl">Thanks — that&rsquo;s with us.</div>
          <p className="mt-2 text-taupe">
            We read everything and usually reply within a day or two.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex rounded-lg bg-brick px-5 py-2.5 font-medium text-white"
          >
            Back to Prelogue
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-12">
      <h1 className="font-slab text-3xl">Get in touch</h1>
      <p className="mt-2 text-taupe">
        Questions, feedback, or something not working? Tell us and a real person will read it.
        You can also email{" "}
        <a href="mailto:hello@prelogue.studio" className="text-brick hover:underline">
          hello@prelogue.studio
        </a>
        .
      </p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        {error && <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}

        <label className="flex flex-col gap-1">
          <span className={label}>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} required />
        </label>

        <label className="flex flex-col gap-1">
          <span className={label}>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={input}
            required
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className={label}>What&rsquo;s this about?</span>
          <div className="flex flex-wrap gap-2">
            {TOPICS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTopic(t.key)}
                className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                  topic === t.key
                    ? "border-brick bg-brick text-white"
                    : "border-tan text-taupe hover:border-brick"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className={label}>Message</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={6}
            maxLength={5000}
            className={input}
            required
          />
        </label>

        {/* Honeypot: hidden from people, irresistible to bots. */}
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          className="hidden"
        />

        <button
          disabled={busy}
          className="rounded-lg bg-brick px-5 py-3 font-medium text-white disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send message"}
        </button>
        <p className="text-xs text-muted">
          We only use your email to reply. See our{" "}
          <Link href="/privacy" className="underline hover:text-brick">
            Privacy Policy
          </Link>
          .
        </p>
      </form>
    </main>
  );
}
