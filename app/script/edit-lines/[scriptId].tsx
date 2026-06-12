import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { ErrorState } from "@/components/ErrorState";
import type { ParsedScript } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

const MERGE_CAP = 2500;

interface Item {
  key: string;
  sceneIndex: number;
  type: string; // "dialogue" | "action" | "parenthetical"
  character_name?: string;
  text: string;
}

// Common screenplay abbreviations whose trailing period is NOT a sentence end.
const ABBR = new Set([
  "PVT", "SGT", "LT", "CPL", "COL", "GEN", "CAPT", "CMDR", "MAJ",
  "MR", "MRS", "MS", "DR", "JR", "SR", "ST", "VS", "DEPT", "GOV", "REP", "SEN", "PROF", "NO",
]);
function endsWithAbbrev(s: string): boolean {
  const m = s.match(/(\S+)\.$/);
  if (!m) return false;
  const w = m[1];
  return /^[A-Za-z]$/.test(w) || ABBR.has(w.toUpperCase()); // single initial or known abbrev
}

// Break a chunk into sentences so each line is movable on its own — but keep
// abbreviations/initials (PVT., D.W., etc.) attached to the next fragment.
function splitSentences(text: string): string[] {
  const raw = (text.match(/.*?[.!?]+(?:\s+|$)|.+$/g) ?? [text])
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of raw) {
    if (out.length && endsWithAbbrev(out[out.length - 1])) {
      out[out.length - 1] = `${out[out.length - 1]} ${part}`;
    } else {
      out.push(part);
    }
  }
  return out.length ? out : [text];
}

export default function EditLinesScreen() {
  const { scriptId } = useLocalSearchParams<{ scriptId: string }>();
  const router = useRouter();

  const [title, setTitle] = useState("Edit Lines");
  const [items, setItems] = useState<Item[]>([]);
  const [headings, setHeadings] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mergeSourceKey, setMergeSourceKey] = useState<string | null>(null);

  const parsedRef = useRef<any>(null);
  const keyCounter = useRef(0);

  useEffect(() => {
    load();
  }, [scriptId]);

  async function load() {
    try {
      const { data: script, error } = await supabase
        .from("scripts")
        .select("title, parsed_json")
        .eq("id", scriptId)
        .single();
      if (error) throw error;
      setTitle(script.title ?? "Edit Lines");
      const parsed = script.parsed_json as ParsedScript | null;
      parsedRef.current = parsed ?? {};

      // Flatten + split every element into sentences so each row is movable.
      const its: Item[] = [];
      const hs: Record<number, string> = {};
      for (const scene of parsed?.scenes ?? []) {
        hs[scene.scene_index] = scene.heading ?? "";
        for (const el of scene.elements ?? []) {
          if (el.type === "character") continue; // redundant speaker label
          for (const sent of splitSentences(el.text)) {
            its.push({
              key: String(keyCounter.current++),
              sceneIndex: scene.scene_index,
              type: el.type,
              character_name: el.character_name,
              text: sent,
            });
          }
        }
      }
      setItems(its);
      setHeadings(hs);
      setLoadError(false);
    } catch (err) {
      console.warn("Edit lines load error:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  // Fold one line's text into another (keeping the target's speaker), preserving
  // reading order, and remove the source line.
  function mergeInto(sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey) {
      setMergeSourceKey(null);
      return;
    }
    setItems((prev) => {
      const srcIdx = prev.findIndex((i) => i.key === sourceKey);
      const tgtIdx = prev.findIndex((i) => i.key === targetKey);
      if (srcIdx < 0 || tgtIdx < 0) return prev;
      const src = prev[srcIdx];
      const tgt = prev[tgtIdx];
      const mergedText = (srcIdx < tgtIdx ? `${src.text} ${tgt.text}` : `${tgt.text} ${src.text}`)
        .replace(/\s+/g, " ")
        .trim();
      return prev
        .map((i) => (i.key === targetKey ? { ...i, text: mergedText } : i))
        .filter((i) => i.key !== sourceKey);
    });
    setMergeSourceKey(null);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const order: number[] = [];
      const seen = new Set<number>();
      for (const it of items) {
        if (!seen.has(it.sceneIndex)) {
          seen.add(it.sceneIndex);
          order.push(it.sceneIndex);
        }
      }
      let scenes = order.map((si) => ({
        heading: headings[si] ?? "",
        scene_index: si,
        elements: items
          .filter((i) => i.sceneIndex === si)
          .map((i) =>
            i.character_name
              ? { type: i.type, character_name: i.character_name, text: i.text }
              : { type: i.type, text: i.text }
          ),
      }));

      // Re-merge consecutive same-speaker runs (matches parse-script).
      scenes = scenes.map((sc) => {
        const merged: any[] = [];
        for (const el of sc.elements) {
          const last = merged[merged.length - 1];
          const sameRun =
            !!last &&
            last.type === el.type &&
            (el.type === "action" ||
              (el.type === "dialogue" && last.character_name === el.character_name));
          if (sameRun && last.text.length + el.text.length + 1 <= MERGE_CAP) {
            last.text = `${last.text} ${el.text}`;
          } else {
            merged.push({ ...el });
          }
        }
        return { ...sc, elements: merged };
      });

      const next = { ...(parsedRef.current ?? {}), scenes };
      const { error } = await supabase
        .from("scripts")
        .update({ parsed_json: next })
        .eq("id", scriptId);
      if (error) throw error;
      setDirty(false);
      Alert.alert("Saved", "Line assignments updated. The next table read will use them.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: "Edit Lines", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (loadError) {
    return (
      <View style={[s.center, { justifyContent: "center" }]}>
        <Stack.Screen options={{ title: "Edit Lines", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <ErrorState onRetry={() => { setLoading(true); load(); }} />
      </View>
    );
  }

  const renderItem = ({ item, index }: { item: Item; index: number }) => {
    const prev = items[index - 1];
    const showHeading = index === 0 || prev?.sceneIndex !== item.sceneIndex;
    const isNarr = item.type !== "dialogue";
    const isSource = mergeSourceKey === item.key;
    const isTargetable = !!mergeSourceKey && !isSource;
    return (
      <View>
        {showHeading && headings[item.sceneIndex] ? (
          <Text style={s.heading} numberOfLines={1}>{headings[item.sceneIndex]}</Text>
        ) : null}
        <TouchableOpacity
          style={[s.row, isSource && s.rowSource, isTargetable && s.rowTargetable]}
          activeOpacity={0.7}
          onPress={() => {
            if (mergeSourceKey) {
              if (isSource) setMergeSourceKey(null);
              else mergeInto(mergeSourceKey, item.key);
            } else {
              setMergeSourceKey(item.key);
            }
          }}
        >
          <View style={[s.tag, isNarr ? s.tagNarr : s.tagChar]}>
            {isNarr ? (
              <Feather name="film" size={11} color={colors.textSecondary} />
            ) : (
              <Text style={s.tagCharText} numberOfLines={1}>{item.character_name}</Text>
            )}
          </View>
          <Text style={[s.lineText, isNarr && s.lineTextNarr]} numberOfLines={3}>
            {item.text}
          </Text>
          {isTargetable ? <Feather name="corner-down-left" size={15} color={colors.primary} /> : null}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={s.container}>
      <Stack.Screen
        options={{
          title,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: "#fff",
          headerRight: () =>
            saving ? (
              <ActivityIndicator color={colors.primary} style={{ marginRight: 8 }} />
            ) : (
              <TouchableOpacity onPress={save} disabled={!dirty} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={[s.saveText, !dirty && { color: colors.textMuted }]}>Save</Text>
              </TouchableOpacity>
            ),
        }}
      />

      {mergeSourceKey ? (
        <View style={s.banner}>
          <Feather name="corner-down-left" size={14} color="#fff" />
          <Text style={s.bannerText} numberOfLines={1}>Now tap the line this should join</Text>
          <TouchableOpacity onPress={() => setMergeSourceKey(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={s.bannerCancel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={s.hint}>Tap a line, then tap the line it should be joined to (it takes that line's speaker).</Text>
      )}

      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 60 }}
        initialNumToRender={25}
        maxToRenderPerBatch={25}
        windowSize={11}
        removeClippedSubviews
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, paddingHorizontal: 32 },
  saveText: { color: colors.primary, fontSize: 16, fontWeight: "700", marginRight: 8 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },

  banner: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: spacing.lg, marginVertical: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.md, backgroundColor: colors.primary },
  bannerText: { color: "#fff", fontSize: 13, fontWeight: "600", flex: 1 },
  bannerCancel: { color: "#fff", fontSize: 13, fontWeight: "700", textDecorationLine: "underline" },

  heading: { color: colors.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginTop: 14, marginBottom: 6, paddingHorizontal: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 8, borderRadius: radius.md, marginBottom: 4, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder },
  rowSource: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.primaryMuted },
  rowTargetable: { borderColor: "rgba(108,92,231,0.35)" },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm, minWidth: 60, alignItems: "center" },
  tagChar: { backgroundColor: "rgba(108,92,231,0.18)" },
  tagCharText: { color: colors.primary, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  tagNarr: { backgroundColor: colors.elevated, minWidth: 36 },
  lineText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 19 },
  lineTextNarr: { color: colors.textSecondary, fontStyle: "italic" },
});
