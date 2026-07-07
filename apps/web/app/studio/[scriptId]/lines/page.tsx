"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";
import type { ParsedScript, SceneElement } from "@/lib/shared";

// Keep in step with parse-script / the mobile editor: consecutive same-speaker
// runs are re-merged on save, capped so no single element grows unbounded.
const MERGE_CAP = 2500;
const ACTION = "__action__";
const PAREN = "__paren__";

type RowType = Exclude<SceneElement["type"], "character">; // dialogue | action | parenthetical

type Row = {
  key: string;
  sceneIndex: number;
  type: RowType;
  character_name?: string;
  text: string;
};

// Shape written back into parsed_json.scenes[].elements[].
type OutEl = { type: string; character_name?: string; text: string };
type OutScene = { heading: string; scene_index: number; elements: OutEl[] };

const roleValue = (r: Row): string =>
  r.type === "dialogue" ? r.character_name ?? "" : r.type === "parenthetical" ? PAREN : ACTION;

const roleLabel = (r: Row): string =>
  r.type === "dialogue" ? r.character_name || "Speaker" : r.type === "parenthetical" ? "( )" : "Action";

// Sentence splitter (mirrors the mobile editor) — keeps initials/abbreviations
// (PVT., D.W.) attached so "Split" breaks on real sentence ends.
const ABBR = new Set([
  "PVT", "SGT", "LT", "CPL", "COL", "GEN", "CAPT", "CMDR", "MAJ",
  "MR", "MRS", "MS", "DR", "JR", "SR", "ST", "VS", "DEPT", "GOV", "REP", "SEN", "PROF", "NO",
]);
function endsWithAbbrev(s: string): boolean {
  const m = s.match(/(\S+)\.$/);
  if (!m) return false;
  return /^[A-Za-z]$/.test(m[1]) || ABBR.has(m[1].toUpperCase());
}
function splitSentences(text: string): string[] {
  const raw = (text.match(/.*?[.!?]+(?:\s+|$)|.+$/g) ?? [text]).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of raw) {
    if (out.length && endsWithAbbrev(out[out.length - 1])) out[out.length - 1] += ` ${part}`;
    else out.push(part);
  }
  return out.length ? out : [text];
}

export default function EditLinesPage() {
  const { scriptId } = useParams<{ scriptId: string }>();
  const router = useRouter();
  const supabase = getBrowserClient();

  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [headings, setHeadings] = useState<Record<number, string>>({});
  const [roleOptions, setRoleOptions] = useState<string[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedRef = useRef<Record<string, unknown>>({});
  const keyCounter = useRef(0);
  const nextKey = () => String(keyCounter.current++);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push(`/sign-in?next=/studio/${scriptId}/lines`);
      return;
    }
    const { data: script } = await supabase
      .from("scripts")
      .select("title, writer_id, parsed_json")
      .eq("id", scriptId)
      .single();
    if (!script) {
      router.push("/studio"); // not found
      return;
    }
    if (script.writer_id !== user.id) {
      // Admins can edit any script (e.g. generated scenes owned by the house account).
      const { data: me } = await supabase.from("users").select("is_admin").eq("id", user.id).single();
      if (!me?.is_admin) {
        router.push("/studio"); // not the owner
        return;
      }
    }
    setTitle(script.title ?? "");
    const parsed = (script.parsed_json as ParsedScript | null) ?? { scenes: [], characters: [] };
    parsedRef.current = parsed as unknown as Record<string, unknown>;

    const rws: Row[] = [];
    const hs: Record<number, string> = {};
    const names = new Set<string>();
    for (const scene of parsed.scenes ?? []) {
      hs[scene.scene_index] = scene.heading ?? "";
      for (const el of scene.elements ?? []) {
        if (el.type === "character") continue; // redundant speaker label
        if (el.type === "dialogue" && el.character_name) names.add(el.character_name);
        rws.push({
          key: nextKey(),
          sceneIndex: scene.scene_index,
          type: el.type as RowType,
          character_name: el.character_name,
          text: el.text,
        });
      }
    }
    const { data: chars } = await supabase.from("characters").select("name").eq("script_id", scriptId);
    for (const c of chars ?? []) if (c?.name) names.add(c.name);

    setRoleOptions(Array.from(names).sort());
    setRows(rws);
    setHeadings(hs);
    setLoading(false);
  }, [scriptId, router, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const touch = () => {
    setDirty(true);
    setSaved(false);
  };

  const patchRow = useCallback((key: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    touch();
  }, []);

  const setRole = (key: string, role: string) => {
    if (role === ACTION) patchRow(key, { type: "action", character_name: undefined });
    else if (role === PAREN) patchRow(key, { type: "parenthetical", character_name: undefined });
    else patchRow(key, { type: "dialogue", character_name: role });
  };

  const deleteRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    if (editingKey === key) setEditingKey(null);
    touch();
  };

  const addBelow = (key: string) => {
    const nk = nextKey();
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.key === key);
      if (idx < 0) return prev;
      const next = [...prev];
      next.splice(idx + 1, 0, { key: nk, sceneIndex: prev[idx].sceneIndex, type: "action", text: "" });
      return next;
    });
    setEditingKey(nk);
    touch();
  };

  const mergeUp = (key: string) => {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.key === key);
      if (idx <= 0) return prev;
      const above = prev[idx - 1];
      const text = `${above.text} ${prev[idx].text}`.replace(/\s+/g, " ").trim();
      const next = [...prev];
      next[idx - 1] = { ...above, text };
      next.splice(idx, 1);
      return next;
    });
    if (editingKey === key) setEditingKey(null);
    touch();
  };

  const splitRow = (key: string) => {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.key === key);
      if (idx < 0) return prev;
      const r = prev[idx];
      const parts = splitSentences(r.text);
      if (parts.length < 2) return prev;
      const pieces: Row[] = parts.map((t) => ({
        key: nextKey(),
        sceneIndex: r.sceneIndex,
        type: r.type,
        character_name: r.character_name,
        text: t,
      }));
      const next = [...prev];
      next.splice(idx, 1, ...pieces);
      return next;
    });
    setEditingKey(null);
    touch();
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const order: number[] = [];
      const seen = new Set<number>();
      for (const r of rows) if (!seen.has(r.sceneIndex)) (seen.add(r.sceneIndex), order.push(r.sceneIndex));

      let scenes: OutScene[] = order.map((si) => ({
        heading: headings[si] ?? "",
        scene_index: si,
        elements: rows
          .filter((r) => r.sceneIndex === si)
          .map((r): OutEl => {
            const text = r.text.trim();
            return r.type === "dialogue" && r.character_name
              ? { type: r.type, character_name: r.character_name, text }
              : { type: r.type, text };
          })
          .filter((el) => el.text.length > 0),
      }));

      // Re-merge consecutive same-speaker runs (matches parse-script).
      scenes = scenes.map((sc) => {
        const merged: OutEl[] = [];
        for (const el of sc.elements) {
          const last = merged[merged.length - 1];
          const sameRun =
            !!last &&
            last.type === el.type &&
            (el.type === "action" ||
              (el.type === "dialogue" && last.character_name === (el as { character_name?: string }).character_name));
          if (sameRun && last.text.length + el.text.length + 1 <= MERGE_CAP) {
            last.text = `${last.text} ${el.text}`;
          } else {
            merged.push({ ...el });
          }
        }
        return { ...sc, elements: merged };
      });

      const next = { ...(parsedRef.current ?? {}), scenes };
      const { error: upErr } = await supabase.from("scripts").update({ parsed_json: next }).eq("id", scriptId);
      if (upErr) throw upErr;
      parsedRef.current = next;
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Couldn't save — please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-3xl px-6 py-16 text-taupe">Loading…</main>;
  }

  let lastScene = -1;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between gap-3">
        <Link href={`/studio/${scriptId}`} className="text-sm text-taupe hover:text-ink">
          ← Casting
        </Link>
        <div className="flex items-center gap-3">
          {saved && !dirty && <span className="text-sm text-green-700">Saved ✓</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <h1 className="mt-5 font-slab text-3xl">Edit lines · {title}</h1>
      <p className="mt-2 text-sm text-taupe">
        Fix anything the parser got wrong. Tap <span className="font-medium">Edit</span> to change a line&rsquo;s text or
        move it to another character; use <span className="font-medium">Split</span>/<span className="font-medium">Merge</span> to
        break apart or join lines, and <span className="font-medium">Delete</span> to remove stray text. Changes apply to the
        next table read.
      </p>
      {error && <p className="mt-3 rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}

      <div className="mt-6 space-y-2">
        {rows.map((r) => {
          const showHeading = r.sceneIndex !== lastScene;
          lastScene = r.sceneIndex;
          const editing = editingKey === r.key;
          return (
            <div key={r.key}>
              {showHeading && headings[r.sceneIndex] ? (
                <div className="mb-1 mt-5 text-xs font-bold uppercase tracking-wider text-muted">
                  {headings[r.sceneIndex]}
                </div>
              ) : null}

              {editing ? (
                <div className="rounded-lg border-2 border-brick bg-ivory p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted">Speaker</span>
                    <select
                      value={roleValue(r)}
                      onChange={(e) => setRole(r.key, e.target.value)}
                      className="rounded-lg border border-tan bg-elevated px-2 py-1.5 text-sm outline-none focus:border-brick"
                    >
                      <option value={ACTION}>Action / Narrator</option>
                      <option value={PAREN}>(Parenthetical)</option>
                      {roleOptions.length > 0 && <option disabled>──────────</option>}
                      {roleOptions.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    autoFocus
                    value={r.text}
                    onChange={(e) => patchRow(r.key, { text: e.target.value })}
                    rows={Math.min(6, Math.max(2, Math.ceil(r.text.length / 60)))}
                    className="mt-2 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
                    placeholder="Type or paste the line…"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => setEditingKey(null)}
                      className="rounded-lg bg-brick px-3 py-1.5 text-xs font-medium text-white"
                    >
                      Done
                    </button>
                    <button
                      onClick={() => splitRow(r.key)}
                      className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium hover:bg-elevated"
                    >
                      ✂ Split into sentences
                    </button>
                    <button
                      onClick={() => mergeUp(r.key)}
                      className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium hover:bg-elevated"
                    >
                      ⤴ Merge into line above
                    </button>
                    <button
                      onClick={() => addBelow(r.key)}
                      className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium hover:bg-elevated"
                    >
                      ＋ Add line below
                    </button>
                    <button
                      onClick={() => deleteRow(r.key)}
                      className="ml-auto rounded-lg border border-brick/40 px-3 py-1.5 text-xs font-medium text-brick hover:bg-brick/5"
                    >
                      🗑 Delete
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-lg border border-tan bg-ivory px-3 py-2">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      r.type === "dialogue" ? "bg-brick/15 text-brick" : "bg-elevated text-muted"
                    }`}
                    style={{ minWidth: 54, textAlign: "center" }}
                  >
                    {roleLabel(r)}
                  </span>
                  <p
                    className={`flex-1 text-sm ${r.type === "dialogue" ? "text-ink" : "italic text-taupe"}`}
                    onClick={() => setEditingKey(r.key)}
                    role="button"
                  >
                    {r.text || <span className="text-muted">(empty)</span>}
                  </p>
                  <button
                    onClick={() => setEditingKey(r.key)}
                    className="shrink-0 rounded-lg border border-tan px-2.5 py-1 text-xs font-medium text-taupe hover:bg-elevated"
                  >
                    ✏️ Edit
                  </button>
                  <button
                    onClick={() => deleteRow(r.key)}
                    className="shrink-0 rounded-lg border border-tan px-2 py-1 text-xs text-muted hover:border-brick/40 hover:text-brick"
                    aria-label="Delete line"
                  >
                    🗑
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="text-sm text-muted">Nothing parsed yet. Once the screenplay is parsed, its lines show here.</p>
        )}
      </div>

      {rows.length > 0 && (
        <div className="mt-8 flex items-center justify-end gap-3 border-t border-tan pt-5">
          {dirty && <span className="text-sm text-taupe">Unsaved changes</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-lg bg-brick px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </main>
  );
}
