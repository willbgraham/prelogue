import Link from "next/link";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { VideoIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "How it works - Prelogue Studio",
  description:
    "For writers: upload a screenplay, cast AI voices, hear it performed, and host live readings. For actors: read a role by webcam and get cast.",
};

const DEMO_SCRIPT_SLUG = "booth-nine";

const WRITER_STEPS = [
  {
    title: "Upload your screenplay",
    body: "Drop in a PDF. Prelogue parses it into an ordered screenplay — scenes, dialogue, and action.",
  },
  {
    title: "Cast the voices",
    body: "Give each character an AI voice and a narrator for the action lines. Preview any voice instantly.",
  },
  {
    title: "Hear the table read",
    body: "Your script performs aloud while the screenplay types out on screen, line by line.",
  },
  {
    title: "Unlock the full read",
    body: "$19 one-time unlocks the complete narration plus private, invite-only sharing. Replays are free forever.",
  },
];

const ACTOR_STEPS = [
  {
    title: "Find a role",
    body: "Browse scripts and open a character that speaks to you — every role is open to read.",
  },
  {
    title: "Record by webcam",
    body: "Read your lines from the on-screen teleprompter; Prelogue captures each one as you go.",
  },
  {
    title: "Get cast",
    body: "Your take splices into the table read in place of the AI voice — and viewers can cast you in the role.",
  },
];

const LIVE_STEPS = [
  {
    title: "Schedule it",
    body: "Pick a date in your script's studio — Prelogue spins up a Prelogue-hosted Zoom meeting automatically.",
  },
  {
    title: "Cast your readers",
    body: "Actors sign up for roles and you watch their takes, then choose who reads each part.",
  },
  {
    title: "Perform live",
    body: "Everyone joins the Zoom reading in real time — and it's recorded to post on the Prelogue YouTube.",
  },
];

function Steps({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <ol className="mt-6 space-y-5">
      {steps.map((s, i) => (
        <li key={s.title} className="flex gap-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brick font-slab text-sm text-white">
            {i + 1}
          </div>
          <div>
            <h3 className="font-slab text-lg leading-tight">{s.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-taupe">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function HowItWorks() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <SiteHeader />

      <section className="mt-12 max-w-2xl">
        <h1 className="font-slab text-4xl leading-tight sm:text-5xl">
          How Prelogue works
        </h1>
        <p className="mt-4 text-taupe">
          A screenplay, performed — by AI voices and real actors, with the pages
          on screen the whole way. Two ways in:
        </p>
      </section>

      <section className="mt-12 grid gap-5 lg:grid-cols-2">
        {/* For Writers */}
        <div className="rounded-2xl border border-tan bg-ivory p-8">
          <div className="font-mono text-xs uppercase tracking-wider text-brick">
            For writers
          </div>
          <h2 className="mt-2 font-slab text-2xl">Bring your script to life</h2>
          <Steps steps={WRITER_STEPS} />
          <Link
            href="/studio/upload"
            className="mt-7 inline-flex rounded-xl bg-brick px-5 py-3 font-medium text-white"
          >
            Upload a script
          </Link>
        </div>

        {/* For Actors */}
        <div className="rounded-2xl border border-tan bg-ivory p-8">
          <div className="font-mono text-xs uppercase tracking-wider text-forest">
            For actors
          </div>
          <h2 className="mt-2 font-slab text-2xl">Read a role, get cast</h2>
          <Steps steps={ACTOR_STEPS} />
          <Link
            href={`/script/${DEMO_SCRIPT_SLUG}`}
            className="mt-7 inline-flex items-center gap-2 rounded-xl border border-tan px-5 py-3 font-medium text-taupe hover:bg-elevated"
          >
            <VideoIcon className="h-4 w-4" />
            Read a role in the demo
          </Link>
        </div>
      </section>

      {/* Live readings — for writers */}
      <section className="mt-12 rounded-2xl border border-tan bg-ivory p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-xl">
            <div className="font-mono text-xs uppercase tracking-wider text-brick">New · for writers</div>
            <h2 className="mt-2 font-slab text-2xl">Host a live reading 🎭</h2>
            <p className="mt-2 text-taupe">
              Beyond AI voices and recorded takes — schedule a <strong>live table read on Zoom</strong>. Actors
              sign up for roles, you pick the cast, everyone performs together in real time, and the recording
              gets posted to the Prelogue YouTube.
            </p>
          </div>
          <Link
            href="/live"
            className="inline-flex shrink-0 rounded-xl border border-tan px-5 py-3 font-medium text-taupe hover:bg-elevated"
          >
            See upcoming readings →
          </Link>
        </div>
        <div className="mt-7 grid gap-6 sm:grid-cols-3">
          {LIVE_STEPS.map((s, i) => (
            <div key={s.title}>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brick font-slab text-sm text-white">
                {i + 1}
              </div>
              <h3 className="mt-3 font-slab text-lg leading-tight">{s.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-taupe">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-12 rounded-2xl border border-tan bg-elevated p-8 text-center">
        <h2 className="font-slab text-2xl">Hear it for yourself</h2>
        <p className="mx-auto mt-2 max-w-md text-taupe">
          Play the Booth Nine demo scene — a full AI table read you can listen
          to right now, no account needed.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={`/script/${DEMO_SCRIPT_SLUG}`}
            className="rounded-xl bg-brick px-5 py-3 font-medium text-white"
          >
            ▶ Try the demo scene
          </Link>
          <Link
            href="/pricing"
            className="rounded-xl border border-tan px-5 py-3 font-medium text-taupe hover:bg-ivory"
          >
            See pricing
          </Link>
        </div>
      </section>
    </main>
  );
}
