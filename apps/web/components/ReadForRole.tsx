"use client";

import { useState } from "react";
import Link from "next/link";
import { VideoIcon } from "@/components/icons";
import { useRoles } from "@/lib/useRoles";

type Role = { id: string; name: string; line_count: number; description?: string | null };

/**
 * "Actors — Read for a Role" entry point, shown above the read. Collapsed by
 * default (a button) so it doesn't push the script down; expands to the
 * per-character record cards.
 */
export function ReadForRole({ characters }: { characters: Role[] }) {
  const [open, setOpen] = useState(false);
  const { userId, loading, has, addRole } = useRoles();
  if (!characters.length) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-tan bg-elevated">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-ivory"
      >
        <span className="flex items-center gap-2 font-slab text-lg">
          <VideoIcon className="h-5 w-5 text-brick" />
          Actors — Read for a Role
        </span>
        <span className="text-sm text-taupe">
          {open ? "Hide ▲" : `${characters.length} role${characters.length === 1 ? "" : "s"} ▾`}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-tan px-5 py-4">
          {userId && !loading && !has("actor") ? (
            <div className="rounded-xl border border-tan bg-ivory px-4 py-5 text-center">
              <p className="text-sm text-taupe">
                Recording is for actors — add the Actor role to read for a part.
              </p>
              <button
                onClick={() => addRole("actor")}
                className="mt-3 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
              >
                Become an actor
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm text-taupe">
                Pick a character and record your performance by webcam — your take
                splices into the table read.
              </p>
              {characters.map((c) => (
                <div key={c.id} className="rounded-xl border border-tan bg-ivory px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-sm text-muted">{c.line_count} lines</div>
                    </div>
                    <Link
                      href={`/record/${c.id}`}
                      className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
                    >
                      <VideoIcon className="h-4 w-4" />
                      Read for this role
                    </Link>
                  </div>
                  {c.description && (
                    <p className="mt-2 text-xs leading-snug text-taupe">{c.description}</p>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
