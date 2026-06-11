import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractText } from "https://esm.sh/unpdf@0.12.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { script_id } = await req.json();
    if (!script_id) {
      return new Response(JSON.stringify({ error: "script_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch script record
    const { data: script, error: scriptError } = await supabase
      .from("scripts")
      .select("id, file_url")
      .eq("id", script_id)
      .single();

    if (scriptError || !script) {
      return new Response(
        JSON.stringify({ error: "Script not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Download PDF from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("scripts")
      .download(script.file_url);

    if (downloadError || !fileData) {
      return new Response(
        JSON.stringify({ error: "Failed to download PDF" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract text using unpdf
    const arrayBuffer = await fileData.arrayBuffer();
    const { text: fullText } = await extractText(new Uint8Array(arrayBuffer));

    // Parse screenplay format
    const lines = fullText.split("\n");
    const scenes: { heading: string; scene_index: number }[] = [];
    const charLineCount: Record<string, number> = {};
    const charDialogue: Record<string, { scene_index: number; text: string }[]> = {};

    // First pass: find character names (ALL CAPS with 2+ occurrences)
    const potentialChars = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const match = line.match(
        /^([A-Z][A-Z\s.'-]{1,28}?)(\s*\((?:V\.O\.|O\.S\.|CONT'D|RADIO|ON RADIO|O\.C\.)\s*\))?$/
      );
      if (!match) continue;
      const name = match[1].trim();
      if (
        name.length < 2 ||
        /^(INT\.|EXT\.|CUT TO|FADE|SMASH|THE |BACK |SOUND|SUPER|CLOSE|ANGLE|CONT|END |TITLE)/.test(name) ||
        /^\d/.test(name)
      ) continue;

      let nextLine = "";
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        nextLine = lines[j].trim();
        if (nextLine) break;
      }
      if (nextLine && !/^(INT\.|EXT\.)/.test(nextLine)) {
        potentialChars.set(name, (potentialChars.get(name) || 0) + 1);
      }
    }

    const confirmedChars = new Set<string>();
    for (const [name, count] of potentialChars) {
      if (count >= 2) confirmedChars.add(name);
    }

    // Second pass: extract scenes and dialogue
    let currentScene = -1;
    let currentChar: string | null = null;
    let collectingDialogue = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (/^(INT\.|EXT\.)/.test(line)) {
        currentScene = scenes.length;
        scenes.push({ heading: line, scene_index: currentScene });
        collectingDialogue = false;
        continue;
      }

      const charMatch = line.match(
        /^([A-Z][A-Z\s.'-]{1,28}?)(\s*\((?:V\.O\.|O\.S\.|CONT'D|RADIO|ON RADIO|O\.C\.)\s*\))?$/
      );
      if (charMatch) {
        const name = charMatch[1].trim();
        if (confirmedChars.has(name)) {
          currentChar = name;
          collectingDialogue = true;
          charLineCount[name] = (charLineCount[name] || 0) + 1;
          if (!charDialogue[name]) charDialogue[name] = [];
          continue;
        }
      }

      if (collectingDialogue && currentChar && line && !line.startsWith("(")) {
        if (/^[A-Z][A-Z\s.'-]+$/.test(line) || /^(INT\.|EXT\.)/.test(line)) {
          collectingDialogue = false;
        } else {
          charDialogue[currentChar].push({
            scene_index: Math.max(0, currentScene),
            text: line,
          });
        }
      }
    }

    // Build parsed JSON
    const parsedCharacters = Object.entries(charLineCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([name, count]) => ({
        name,
        description: "",
        lines: (charDialogue[name] || []).slice(0, 100),
        line_count: count,
      }));

    const parsedJson = {
      scenes: scenes.map((s) => ({
        heading: s.heading,
        scene_index: s.scene_index,
        elements: [],
      })),
      characters: parsedCharacters,
    };

    // Update script with parsed data
    await supabase
      .from("scripts")
      .update({ parsed_json: parsedJson })
      .eq("id", script_id);

    // Insert characters
    const topChars = parsedCharacters.filter((c) => c.line_count >= 2).slice(0, 20);
    if (topChars.length > 0) {
      await supabase.from("characters").insert(
        topChars.map((c) => ({
          script_id,
          name: c.name,
          description: null,
          line_count: c.line_count,
        }))
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        scenes: scenes.length,
        characters: topChars.length,
        character_names: topChars.map((c) => c.name),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Parse error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
