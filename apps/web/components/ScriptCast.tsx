"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { getBrowserClient } from "@/lib/supabase/client";
import type { VoiceConfig } from "@/lib/shared";

type Char = { id: string; name: string };
type Actor = { display_name: string; username: string | null; avatar_url: string | null };
type Choice = { character_id: string; actor: Actor | null };

/**
 * Who reads each character: the writer's-choice actor (avatar + profile link) if
 * one is cast, otherwise the configured AI voice. Reads are only visible once
 * approved (RLS), so a cast-but-unapproved read shows as its AI voice until then.
 */
export function ScriptCast({
  scriptId,
  characters,
  voiceConfig,
}: {
  scriptId: string;
  characters: Char[];
  voiceConfig: VoiceConfig | null;
}) {
  const supabase = getBrowserClient();
  const [cast, setCast] = useState<Record<string, Actor | null>>({});
  const [voiceNames, setVoiceNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("submissions")
        .select("character_id, actor:users!submissions_actor_id_fkey(display_name, username, avatar_url)")
        .eq("script_id", scriptId)
        .eq("is_writers_choice", true)
        .eq("moderation_status", "approved");
      if (!alive) return;
      const map: Record<string, Actor | null> = {};
      for (const c of (data as unknown as Choice[]) ?? []) map[c.character_id] = c.actor;
      setCast(map);
    })();
    (async () => {
      const { data } = await supabase.functions.invoke("list-voices", { body: {} });
      if (!alive) return;
      const vn: Record<string, string> = {};
      for (const v of (data?.voices ?? []) as { voice_id: string; name: string }[]) vn[v.voice_id] = v.name;
      setVoiceNames(vn);
    })();
    return () => {
      alive = false;
    };
  }, [scriptId, supabase]);

  if (!characters.length) return null;

  const aiVoiceFor = (name: string): string | null => {
    const vid = voiceConfig?.characters?.[name.toUpperCase()];
    if (!vid) return null;
    return voiceNames[vid] ?? "AI Voice";
  };
  const narratorName = voiceConfig?.narrator_voice_id
    ? voiceNames[voiceConfig.narrator_voice_id] ?? "AI Voice"
    : null;

  return (
    <section className="mt-8">
      <h2 className="font-slab text-lg">Cast</h2>
      <div className="mt-3 divide-y divide-tan overflow-hidden rounded-xl border border-tan bg-ivory">
        {characters.map((c) => {
          const actor = cast[c.id];
          const ai = aiVoiceFor(c.name);
          return (
            <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              {actor ? (
                <CastActor actor={actor} />
              ) : (
                <span className="text-sm text-muted">🎙 {ai ? `AI Voice · ${ai}` : "AI Voice"}</span>
              )}
            </div>
          );
        })}
        {narratorName && (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1 truncate font-medium text-taupe">Narration</span>
            <span className="text-sm text-muted">🎙 AI Voice · {narratorName}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function CastActor({ actor }: { actor: Actor }) {
  const name = actor.display_name || (actor.username ? `@${actor.username}` : "Actor");
  const inner = (
    <span className="flex items-center gap-2">
      <span className="h-7 w-7 shrink-0 overflow-hidden rounded-full border border-tan bg-elevated">
        {actor.avatar_url ? (
          <Image src={actor.avatar_url} alt="" width={28} height={28} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-xs text-taupe">
            {(actor.display_name ?? "A").charAt(0).toUpperCase()}
          </span>
        )}
      </span>
      <span>Read by {name}</span>
    </span>
  );
  return actor.username ? (
    <Link href={`/u/${actor.username}`} className="text-sm text-taupe hover:text-brick">
      {inner}
    </Link>
  ) : (
    <span className="text-sm text-taupe">{inner}</span>
  );
}
