"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * The homepage hero artifact: a page of the real demo scene typing itself out,
 * with margin notes pinned to the lines that show off a feature — a real
 * actor's take, the AI voice library, a per-line [emotion]. It performs the
 * product instead of describing it. Types once (no loop); respects
 * prefers-reduced-motion by rendering the finished page.
 */
type DemoLine =
  | { kind: "slug"; text: string; note?: string }
  | { kind: "action"; text: string; note?: string }
  | { kind: "cue"; who: string; tag?: string; text: string; note?: string };

const LINES: DemoLine[] = [
  { kind: "slug", text: "INT. THE BLUE HOUR DINER - 2:14 A.M." },
  { kind: "action", text: "Rain needles the window. A neon sign stutters pink." },
  { kind: "cue", who: "DANNY", text: "I want out.", note: "AI voice — one of 900+" },
  {
    kind: "cue",
    who: "VERA",
    text: "Mm. And people in hell want ice water.",
    note: "Read by Ceecee — a real actor",
  },
  {
    kind: "cue",
    who: "DANNY",
    tag: "[scared]",
    text: "...That's not a booth number.",
    note: "One line, directed: [scared]",
  },
];

// ~how many characters each line contributes to the typing timeline.
const lineLength = (l: DemoLine) => l.text.length + (l.kind === "cue" ? 4 : 0);

export function HeroScriptDemo() {
  // Total characters revealed across the whole page (monotonic).
  const [chars, setChars] = useState(0);
  const [done, setDone] = useState(false);
  const raf = useRef<number | null>(null);

  const total = LINES.reduce((n, l) => n + lineLength(l), 0);

  useEffect(() => {
    // Reduced motion: jump straight to the finished page on the first frame.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now() + 500; // beat before the first key
    const CPS = 34; // characters per second
    const tick = (now: number) => {
      const n = reduce ? total : Math.max(0, Math.floor(((now - start) / 1000) * CPS));
      if (n >= total) {
        setChars(total);
        setDone(true);
        return;
      }
      setChars(n);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [total]);

  // Slice the global char budget across lines in order (cumulative offsets).
  const offsets = LINES.reduce<number[]>(
    (arr, l) => [...arr, (arr[arr.length - 1] ?? 0) + lineLength(l)],
    []
  );
  const rendered = LINES.map((l, i) => {
    const before = i === 0 ? 0 : offsets[i - 1];
    const len = lineLength(l);
    const mine = Math.max(0, Math.min(len, chars - before));
    const shown = l.text.slice(0, Math.max(0, mine - (l.kind === "cue" ? 4 : 0)));
    return { line: l, shown, complete: mine >= len, started: mine > 0 };
  });
  const activeIdx = rendered.findIndex((r) => r.started && !r.complete);

  return (
    <div className="relative">
      <div className="rounded-xl border border-tan bg-[#faf7ef] shadow-[0_2px_24px_rgba(42,36,32,0.10)]">
        {/* Page header, like the top of a shooting draft */}
        <div className="flex items-center justify-between border-b border-tan/60 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest text-muted">
          <span>Booth Nine — demo scene</span>
          <span>Page 1</span>
        </div>

        <div className="space-y-4 px-5 py-6 sm:px-8">
          {rendered.map(({ line, shown, complete, started }, i) => {
            if (!started) return <div key={i} className="h-2" aria-hidden />;
            const cursor = i === activeIdx && !done;
            return (
              <div key={i}>
                {line.kind === "slug" && (
                  <div className="font-mono text-xs font-bold tracking-wide text-ink sm:text-sm">
                    {shown}
                    {cursor && <Caret />}
                  </div>
                )}
                {line.kind === "action" && (
                  <p className="font-mono text-xs leading-relaxed text-taupe sm:text-sm">
                    {shown}
                    {cursor && <Caret />}
                  </p>
                )}
                {line.kind === "cue" && (
                  <div className="text-center">
                    <div className="font-mono text-xs font-bold tracking-wider text-ink">
                      {line.who}
                      {line.tag && complete && (
                        <span className="ml-2 font-normal text-brick">{line.tag}</span>
                      )}
                    </div>
                    <p className="mx-auto mt-0.5 max-w-[26ch] font-mono text-xs leading-relaxed text-ink sm:max-w-[34ch] sm:text-sm">
                      {shown}
                      {cursor && <Caret />}
                    </p>
                  </div>
                )}
                {line.note && complete && (
                  <div className="mt-1.5 flex justify-end">
                    <span className="animate-[fadeIn_.5s_ease-out] rounded-full border border-brick/40 bg-brick/5 px-2.5 py-0.5 text-[10px] font-medium text-brick">
                      ◂ {line.note}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-tan/60 px-5 py-3">
          <Link
            href="/script/booth-nine"
            className={`inline-flex items-center gap-2 text-sm font-medium text-brick transition-opacity hover:underline ${
              done ? "opacity-100" : "opacity-0"
            }`}
          >
            ▶ Play the full scene — hear it out loud
          </Link>
        </div>
      </div>
    </div>
  );
}

function Caret() {
  return <span className="animate-pulse text-brick">▌</span>;
}
