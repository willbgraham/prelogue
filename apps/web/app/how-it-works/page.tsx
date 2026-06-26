import Link from "next/link";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "How it works — Prelogue",
  description:
    "Upload a screenplay, cast AI voices, and hear it performed as a table read — then bring in real actors by webcam.",
};

const DEMO_SCRIPT_ID = "b0078900-0000-4000-8000-000000000009";

const STEPS = [
  {
    n: "1",
    title: "Bring your script",
    body: "Upload a PDF. Prelogue parses it into an ordered screenplay — scenes, dialogue, and action — ready to perform.",
  },
  {
    n: "2",
    title: "Cast the voices",
    body: "Give each character an AI voice, and a narrator for the action lines, chosen from a large voice library. Preview any voice instantly.",
  },
  {
    n: "3",
    title: "Press play",
    body: "Hear a full table read performed aloud while the screenplay types out on screen, line by line — your pages coming to life.",
  },
  {
    n: "4",
    title: "Bring in real actors",
    body: "Share a role and actors record their lines by webcam. Their takes splice into the read in place of the AI voice, so you hear real performances.",
  },
];

export default function HowItWorks() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <SiteHeader />

      <section className="mt-12 max-w-2xl">
        <h1 className="font-slab text-4xl leading-tight sm:text-5xl">
          How Prelogue works
        </h1>
        <p className="mt-4 text-taupe">
          From a static PDF to a performed table read in minutes — with the
          screenplay on screen the whole way.
        </p>
      </section>

      <section className="mt-12 grid gap-5 sm:grid-cols-2">
        {STEPS.map((s) => (
          <div key={s.n} className="rounded-xl border border-tan bg-ivory p-6">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brick font-slab text-lg text-white">
              {s.n}
            </div>
            <h2 className="mt-4 font-slab text-xl">{s.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-taupe">{s.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-12 rounded-2xl border border-tan bg-elevated p-8 text-center">
        <h2 className="font-slab text-2xl">Hear it for yourself</h2>
        <p className="mx-auto mt-2 max-w-md text-taupe">
          Play the Booth Nine demo scene — a full AI table read you can listen
          to right now, no account needed.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={`/script/${DEMO_SCRIPT_ID}`}
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
