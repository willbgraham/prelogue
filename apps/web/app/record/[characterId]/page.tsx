import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WebcamRecorder } from "@/components/WebcamRecorder";
import type { ParsedScript } from "@/lib/shared";

export default async function RecordPage({
  params,
}: {
  params: Promise<{ characterId: string }>;
}) {
  const { characterId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/sign-in?next=/record/${characterId}`);

  const { data: character } = await supabase
    .from("characters")
    .select("id, name, script_id, scripts(id, title, parsed_json)")
    .eq("id", characterId)
    .single();
  if (!character) notFound();

  const c = character as unknown as {
    id: string;
    name: string;
    script_id: string;
    scripts: { parsed_json: ParsedScript | null } | null;
  };

  return (
    <WebcamRecorder
      characterId={c.id}
      characterName={c.name}
      scriptId={c.script_id}
      parsed={c.scripts?.parsed_json ?? null}
      userId={user.id}
    />
  );
}
