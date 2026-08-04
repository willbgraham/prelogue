"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

type Invite = {
  id: string;
  character_id: string;
  note: string | null;
  character: { name: string } | { name: string }[] | null;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

/**
 * Shown on a script page to an actor the writer invited to read a part.
 * Scripts are private now, so this invitation IS the actor's way in — it grants
 * access (can_view_script) and points at the recorder for their role.
 */
export function InvitedToRead({ scriptId }: { scriptId: string }) {
  const [invites, setInvites] = useState<Invite[]>([]);

  useEffect(() => {
    (async () => {
      const supabase = getBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.email) return;
      // RLS already scopes role_invites to this viewer's email.
      const { data } = await supabase
        .from("role_invites")
        .select("id, character_id, note, character:characters(name)")
        .eq("script_id", scriptId);
      setInvites((data as unknown as Invite[]) ?? []);
    })();
  }, [scriptId]);

  if (!invites.length) return null;

  return (
    <div className="mt-6 rounded-xl border-2 border-brick bg-brick/5 p-5">
      <div className="font-slab text-lg">You&rsquo;re invited to read</div>
      <div className="mt-3 space-y-2">
        {invites.map((i) => {
          const name = one(i.character)?.name ?? "a role";
          return (
            <div
              key={i.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-tan bg-ivory px-4 py-3"
            >
              <div className="min-w-0">
                <div className="font-mono text-sm font-bold uppercase tracking-wide">{name}</div>
                {i.note && <p className="mt-0.5 text-sm text-taupe">&ldquo;{i.note}&rdquo;</p>}
              </div>
              <Link
                href={`/record/${i.character_id}`}
                className="shrink-0 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
              >
                Record your read →
              </Link>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">
        The writer invited you personally. Your takes go back to them for casting.
      </p>
    </div>
  );
}
