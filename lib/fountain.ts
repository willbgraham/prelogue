/**
 * Fountain (.fountain) screenplay format parser.
 * Parses Fountain markup into structured scene/character/dialogue data.
 *
 * Fountain spec: https://fountain.io/syntax
 */

import type { ParsedScript, ParsedScene, ParsedCharacter } from "./types";

export function parseFountain(text: string): ParsedScript {
  const lines = text.split("\n");
  const scenes: ParsedScene[] = [];
  const charMap = new Map<string, { lines: { scene_index: number; text: string }[] }>();

  let currentScene = -1;
  let currentChar: string | null = null;
  let collectingDialogue = false;
  let inTitlePage = true;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Skip title page (everything before first empty line after key: value pairs)
    if (inTitlePage) {
      if (trimmed === "" && i > 0 && !lines[i - 1].trim().includes(":")) {
        inTitlePage = false;
      }
      if (/^(Title|Credit|Author|Source|Draft date|Contact|Copyright):/i.test(trimmed)) {
        continue;
      }
      if (trimmed === "") continue;
      inTitlePage = false;
    }

    // Scene headings: INT. / EXT. / EST. / INT./EXT. or forced with .
    if (
      /^(INT\.|EXT\.|EST\.|INT\.\/EXT\.|I\/E\.)/.test(trimmed.toUpperCase()) ||
      (trimmed.startsWith(".") && trimmed.length > 1 && !trimmed.startsWith(".."))
    ) {
      const heading = trimmed.startsWith(".")
        ? trimmed.substring(1).trim()
        : trimmed;
      currentScene = scenes.length;
      scenes.push({ heading, scene_index: currentScene, elements: [] });
      collectingDialogue = false;
      continue;
    }

    // Character cue: ALL CAPS line (not starting with !)
    // Must be preceded by an empty line in proper Fountain
    const prevLine = i > 0 ? lines[i - 1].trim() : "";
    if (
      prevLine === "" &&
      trimmed !== "" &&
      /^[A-Z][A-Z\s.'-]+$/.test(trimmed.replace(/\s*\(.*\)\s*$/, "")) &&
      !trimmed.startsWith("INT.") &&
      !trimmed.startsWith("EXT.") &&
      !trimmed.startsWith("FADE") &&
      !trimmed.startsWith("CUT TO") &&
      trimmed.length >= 2 &&
      trimmed.length <= 40
    ) {
      // Forced character with @
      const name = trimmed.startsWith("@")
        ? trimmed.substring(1).replace(/\s*\(.*\)\s*$/, "").trim()
        : trimmed.replace(/\s*\(.*\)\s*$/, "").trim();

      currentChar = name;
      collectingDialogue = true;
      if (!charMap.has(name)) {
        charMap.set(name, { lines: [] });
      }
      continue;
    }

    // Dialogue lines (after character cue)
    if (collectingDialogue && currentChar && trimmed !== "") {
      // Parentheticals
      if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
        continue;
      }
      // Still dialogue
      charMap.get(currentChar)?.lines.push({
        scene_index: Math.max(0, currentScene),
        text: trimmed,
      });
      continue;
    }

    // Empty line ends dialogue
    if (trimmed === "" && collectingDialogue) {
      collectingDialogue = false;
      currentChar = null;
    }
  }

  // Build character list sorted by line count
  const characters: ParsedCharacter[] = Array.from(charMap.entries())
    .map(([name, data]) => ({
      name,
      description: "",
      lines: data.lines,
      line_count: data.lines.length,
    }))
    .filter((c) => c.line_count >= 1)
    .sort((a, b) => b.line_count - a.line_count);

  return { scenes, characters };
}

/**
 * Final Draft XML (.fdx) parser.
 * Extracts characters and dialogue from FDX format.
 */
export function parseFDX(xmlText: string): ParsedScript {
  const scenes: ParsedScene[] = [];
  const charMap = new Map<string, { lines: { scene_index: number; text: string }[] }>();

  let currentScene = -1;

  // Simple XML parsing using regex (works for FDX structure)
  const paragraphs: string[] = xmlText.match(/<Paragraph[^>]*>[\s\S]*?<\/Paragraph>/g) || [];

  for (const para of paragraphs) {
    const typeMatch = para.match(/Type="([^"]+)"/);
    const type = typeMatch?.[1] || "";

    // Extract text content
    const textContent = (para.match(/<Text[^>]*>([\s\S]*?)<\/Text>/g) || [])
      .map((t) => t.replace(/<\/?Text[^>]*>/g, "").trim())
      .join(" ")
      .trim();

    if (!textContent) continue;

    if (type === "Scene Heading") {
      currentScene = scenes.length;
      scenes.push({ heading: textContent, scene_index: currentScene, elements: [] });
    } else if (type === "Character") {
      const name = textContent.replace(/\s*\(.*\)$/, "").trim();
      if (!charMap.has(name)) {
        charMap.set(name, { lines: [] });
      }
    } else if (type === "Dialogue") {
      // Find the most recent character
      const lastCharPara = paragraphs
        .slice(0, paragraphs.indexOf(para))
        .reverse()
        .find((p) => /Type="Character"/.test(p));

      if (lastCharPara) {
        const charText = (lastCharPara.match(/<Text[^>]*>([\s\S]*?)<\/Text>/g) || [])
          .map((t) => t.replace(/<\/?Text[^>]*>/g, "").trim())
          .join(" ")
          .replace(/\s*\(.*\)$/, "")
          .trim();

        if (charMap.has(charText)) {
          charMap.get(charText)?.lines.push({
            scene_index: Math.max(0, currentScene),
            text: textContent,
          });
        }
      }
    }
  }

  const characters: ParsedCharacter[] = Array.from(charMap.entries())
    .map(([name, data]) => ({
      name,
      description: "",
      lines: data.lines,
      line_count: data.lines.length,
    }))
    .filter((c) => c.line_count >= 1)
    .sort((a, b) => b.line_count - a.line_count);

  return { scenes, characters };
}
