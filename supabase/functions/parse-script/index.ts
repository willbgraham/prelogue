import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type ElementType = "character" | "dialogue" | "action" | "parenthetical";
interface SceneElement {
  type: ElementType;
  character_name?: string;
  text: string;
}
interface ParsedScene {
  heading: string;
  scene_index: number;
  elements: SceneElement[];
}

const CHAR_CUE_RE =
  /^([A-Z][A-Z\s.'-]{1,28}?)(\s*\((?:V\.O\.|O\.S\.|CONT'D|RADIO|ON RADIO|O\.C\.)\s*\))?$/;
const HEADING_RE = /^(INT\.|EXT\.)/;
const TRANSITION_RE = /^(CUT TO|FADE|SMASH|DISSOLVE|MATCH CUT|HARD CUT|BACK TO|TITLE)/;
const ALL_CAPS_RE = /^[A-Z][A-Z\s.'-]+$/;

/**
 * Reconstruct text lines from a PDF using item positions. unpdf's extractText
 * collapses line breaks, so we walk the pdf.js text items and break a new line
 * whenever `hasEOL` is set or the y-coordinate shifts. Large vertical gaps
 * become blank lines (block separators) so dialogue blocks end correctly.
 */
async function extractLines(data: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(data);
  const out: string[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as any[]).filter((it) => typeof it.str === "string");

    const pageLines: { text: string; y: number }[] = [];
    let cur = "";
    let curY: number | null = null;

    for (const it of items) {
      const y = Array.isArray(it.transform) ? (it.transform[5] as number) : null;
      if (curY !== null && y !== null && Math.abs(y - curY) > 2) {
        pageLines.push({ text: cur, y: curY });
        cur = "";
        curY = null;
      }
      if (curY === null && y !== null) curY = y;
      cur += it.str;
      if (it.hasEOL) {
        pageLines.push({ text: cur, y: curY ?? y ?? 0 });
        cur = "";
        curY = null;
      }
    }
    if (cur) pageLines.push({ text: cur, y: curY ?? 0 });

    // Typical line gap (median) → anything notably larger is a blank line.
    const gaps: number[] = [];
    for (let i = 1; i < pageLines.length; i++) {
      const g = pageLines[i - 1].y - pageLines[i].y;
      if (g > 0) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;

    for (let i = 0; i < pageLines.length; i++) {
      if (i > 0) {
        const gap = pageLines[i - 1].y - pageLines[i].y;
        if (gap > typical * 1.6) out.push("");
      }
      out.push(pageLines[i].text);
    }
    out.push(""); // page boundary
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { script_id, debug } = await req.json();
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

    const { data: script, error: scriptError } = await supabase
      .from("scripts")
      .select("id, file_url")
      .eq("id", script_id)
      .single();

    if (scriptError || !script) {
      return new Response(JSON.stringify({ error: "Script not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("scripts")
      .download(script.file_url);

    if (downloadError || !fileData) {
      return new Response(JSON.stringify({ error: "Failed to download PDF" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const lines = await extractLines(new Uint8Array(arrayBuffer));

    // -----------------------------------------------------------------------
    // First pass: identify character names (ALL CAPS cue lines appearing 2+
    // times with a following non-heading line).
    // -----------------------------------------------------------------------
    const potentialChars = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const match = line.match(CHAR_CUE_RE);
      if (!match) continue;
      const name = match[1].trim();
      if (
        name.length < 2 ||
        /^(INT\.|EXT\.|CUT TO|FADE|SMASH|THE |BACK |SOUND|SUPER|CLOSE|ANGLE|CONT|END |TITLE|BEAT|NOW|LATER|MOMENTS?|CONTINUOUS|MEANWHILE|POV|INSERT|OMITTED)/.test(
          name
        ) ||
        /^\d/.test(name)
      )
        continue;

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

    // -----------------------------------------------------------------------
    // Second pass: ordered element stream per scene + per-character dialogue.
    // A blank line ends a dialogue block.
    // -----------------------------------------------------------------------
    const scenes: ParsedScene[] = [];
    const charDialogue: Record<string, { scene_index: number; text: string }[]> = {};
    const charLineCount: Record<string, number> = {};

    let current: ParsedScene = { heading: "", scene_index: 0, elements: [] };
    scenes.push(current);
    let currentChar: string | null = null;
    let inDialogue = false;
    let dialogueCount = 0; // dialogue lines collected for the current speaker

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (HEADING_RE.test(line)) {
        current = { heading: line, scene_index: scenes.length, elements: [] };
        scenes.push(current);
        currentChar = null;
        inDialogue = false;
        continue;
      }

      // A blank line ends a dialogue block — but only once we've seen actual
      // dialogue. Some scripts put a blank between the cue and the first line.
      if (!line) {
        if (inDialogue && dialogueCount > 0) {
          inDialogue = false;
          currentChar = null;
        }
        continue;
      }

      if (TRANSITION_RE.test(line)) {
        inDialogue = false;
        currentChar = null;
        continue;
      }

      const cue = line.match(CHAR_CUE_RE);
      if (cue && confirmedChars.has(cue[1].trim())) {
        currentChar = cue[1].trim();
        inDialogue = true;
        dialogueCount = 0;
        current.elements.push({
          type: "character",
          character_name: currentChar,
          text: currentChar,
        });
        continue;
      }

      if (inDialogue && currentChar) {
        if (line.startsWith("(")) {
          current.elements.push({
            type: "parenthetical",
            character_name: currentChar,
            text: line,
          });
          continue;
        }
        if (ALL_CAPS_RE.test(line)) {
          inDialogue = false;
          currentChar = null;
          current.elements.push({ type: "action", text: line });
          continue;
        }
        current.elements.push({
          type: "dialogue",
          character_name: currentChar,
          text: line,
        });
        dialogueCount++;
        charLineCount[currentChar] = (charLineCount[currentChar] || 0) + 1;
        if (!charDialogue[currentChar]) charDialogue[currentChar] = [];
        charDialogue[currentChar].push({ scene_index: current.scene_index, text: line });
        continue;
      }

      current.elements.push({ type: "action", text: line });
    }

    const totalElements = scenes.reduce((n, s) => n + s.elements.length, 0);

    // Debug mode: inspect extraction without writing to the DB.
    if (debug) {
      const counts: Record<string, number> = { dialogue: 0, action: 0, character: 0, parenthetical: 0 };
      for (const s of scenes) for (const el of s.elements) counts[el.type] = (counts[el.type] || 0) + 1;
      return new Response(
        JSON.stringify(
          {
            debug: true,
            totalLines: lines.length,
            scenes: scenes.length,
            totalElements,
            elementCounts: counts,
            confirmedChars: [...confirmedChars],
            sampleLines: lines.slice(0, 70),
            sampleElements: scenes.flatMap((s) => s.elements).slice(0, 30),
          },
          null,
          2
        ),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsedCharacters = Object.entries(charLineCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([name, count]) => ({
        name,
        description: "",
        lines: charDialogue[name] || [],
        line_count: count,
      }));

    const parsedJson = { scenes, characters: parsedCharacters };

    await supabase.from("scripts").update({ parsed_json: parsedJson }).eq("id", script_id);

    // Idempotent, non-destructive character insert (don't delete — that would
    // cascade-delete actor submissions).
    const topChars = parsedCharacters.filter((c) => c.line_count >= 2).slice(0, 20);
    const { data: existingChars } = await supabase
      .from("characters")
      .select("name")
      .eq("script_id", script_id);
    const existingNames = new Set((existingChars || []).map((c: any) => c.name));
    const toInsert = topChars.filter((c) => !existingNames.has(c.name));

    if (toInsert.length > 0) {
      await supabase.from("characters").insert(
        toInsert.map((c) => ({
          script_id,
          name: c.name,
          description: null,
          line_count: c.line_count,
        }))
      );
    }
    for (const c of topChars) {
      if (existingNames.has(c.name)) {
        await supabase
          .from("characters")
          .update({ line_count: c.line_count })
          .eq("script_id", script_id)
          .eq("name", c.name);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        scenes: scenes.length,
        elements: totalElements,
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
