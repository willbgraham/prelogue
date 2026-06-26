"use client";

import { useState } from "react";
import Link from "next/link";

type Role = { id: string; name: string; line_count: number };

/**
 * "Actors — Read for a Role" entry point, shown above the read. Collapsed by
 * default (a button) so it doesn't push the script down; expands to the
 * per-character record cards.
 */
export function ReadForRole({ characters }: { characters: Role[] }) {
  const [open, setOpen] = useState(false);
  if (!characters.length) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-tan bg-elevated">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-ivory"
      >
        <span className="font-slab text-lg">🎥 Actors — Read for a Role</span>
        <span className="text-sm text-taupe">
          {open ? "Hide ▲" : `${characters.length} role${characters.length === 1 ? "" : "s"} ▾`}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-tan px-5 py-4">
          <p className="text-sm text-taupe">
            Pick a character and record your performance by webcam — your take
            splices into the table read.
          </p>
          {characters.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-tan bg-ivory px-4 py-3"
            >
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-muted">{c.line_count} lines</div>
              </div>
              <Link
                href={`/record/${c.id}`}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
              >
                🎥 Read this role
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
