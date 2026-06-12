import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
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

const NARRATOR = "__narrator__";
const MERGE_CAP = 2500;

interface Item {
  key: string;
  sceneIndex: number;
  type: string; // "dialogue" | "action" | "parenthetical"
  character_name?: string;
  text: string;
}

export default function EditLinesScreen() {
  const { scriptId } = useLocalSearchParams<{ scriptId: string }>();
  const router = useRouter();

  const [title, setTitle] = useState("Edit Lines");
  const [items, setItems] = useState<Item[]>([]);
  const [headings, setHeadings] = useState<Record<number, string>>({});
  const [characterNames, setCharacterNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sheetKey, setSheetKey] = useState<string | null>(null);

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

      const its: Item[] = [];
      const hs: Record<number, string> = {};
      for (const scene of parsed?.scenes ?? []) {
        hs[scene.scene_index] = scene.heading ?? "";
        for (const el of scene.elements ?? []) {
          if (el.type === "character") continue; // redundant speaker label
          its.push({
            key: String(keyCounter.current++),
            sceneIndex: scene.scene_index,
            type: el.type,
            character_name: el.character_name,
            text: el.text,
          });
        }
      }
      setItems(its);
      setHeadings(hs);
      const names = Array.from(
        new Set([
          ...((parsed as any)?.characters ?? []).map((c: any) => c.name),
          ...its.filter((i) => i.character_name).map((i) => i.character_name as string),
        ])
      ).sort();
      setCharacterNames(names);
      setLoadError(false);
    } catch (err) {
      console.warn("Edit lines load error:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  function reassign(key: string, role: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.key === key
          ? role === NARRATOR
            ? { ...i, type: "action", character_name: undefined }
            : { ...i, type: "dialogue", character_name: role }
          : i
      )
    );
    setDirty(true);
    setSheetKey(null);
  }

  function splitItem(key: string) {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.key === key);
      if (idx < 0) return prev;
      const item = prev[idx];
      const parts = (item.text.match(/.*?[.!?]+(?:\s+|$)|.+$/g) ?? [item.text])
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length <= 1) {
        Alert.alert("Can't split", "This line is a single sentence.");
        return prev;
      }
      const created = parts.map((t) => ({
        key: String(keyCounter.current++),
        sceneIndex: item.sceneIndex,
        type: item.type,
        character_name: item.character_name,
        text: t,
      }));
      return [...prev.slice(0, idx), ...created, ...prev.slice(idx + 1)];
    });
    setDirty(true);
    setSheetKey(null);
  }

  async function save() {
    setSaving(true);
    try {
      // Preserve scene order, regroup items by scene.
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

  const sheetItem = items.find((i) => i.key === sheetKey) || null;

  const renderItem = ({ item, index }: { item: Item; index: number }) => {
    const prev = items[index - 1];
    const showHeading = index === 0 || prev?.sceneIndex !== item.sceneIndex;
    const isNarr = item.type !== "dialogue";
    return (
      <View>
        {showHeading && headings[item.sceneIndex] ? (
          <Text style={s.heading} numberOfLines={1}>{headings[item.sceneIndex]}</Text>
        ) : null}
        <TouchableOpacity style={s.row} activeOpacity={0.7} onPress={() => setSheetKey(item.key)}>
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
          <Feather name="edit-2" size={13} color={colors.textMuted} />
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

      <Text style={s.hint}>Tap a line to reassign it to a character or the narrator. Split a chunk first if only part of it is wrong.</Text>

      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 60 }}
        initialNumToRender={25}
        windowSize={11}
        removeClippedSubviews
      />

      {sheetItem && (
        <View style={s.overlay}>
          <TouchableOpacity style={s.scrim} activeOpacity={1} onPress={() => setSheetKey(null)} />
          <View style={s.sheet}>
            <Text style={s.sheetLine} numberOfLines={3}>“{sheetItem.text}”</Text>
            <Text style={s.sheetLabel}>ASSIGN TO</Text>
            <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
              <TouchableOpacity style={s.roleBtn} onPress={() => reassign(sheetItem.key, NARRATOR)}>
                <Feather name="film" size={15} color={colors.textSecondary} />
                <Text style={s.roleBtnText}>Narrator</Text>
                {sheetItem.type !== "dialogue" && <Feather name="check" size={16} color={colors.primary} />}
              </TouchableOpacity>
              {characterNames.map((name) => (
                <TouchableOpacity key={name} style={s.roleBtn} onPress={() => reassign(sheetItem.key, name)}>
                  <Feather name="user" size={15} color={colors.primary} />
                  <Text style={s.roleBtnText}>{name}</Text>
                  {sheetItem.type === "dialogue" && sheetItem.character_name === name && (
                    <Feather name="check" size={16} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.splitBtn} onPress={() => splitItem(sheetItem.key)} activeOpacity={0.8}>
              <Feather name="scissors" size={15} color={colors.text} />
              <Text style={s.splitBtnText}>Split into sentences</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setSheetKey(null)} activeOpacity={0.7}>
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, paddingHorizontal: 32 },
  saveText: { color: colors.primary, fontSize: 16, fontWeight: "700", marginRight: 8 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },

  heading: { color: colors.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginTop: 14, marginBottom: 6, paddingHorizontal: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 8, borderRadius: radius.md, marginBottom: 4, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm, minWidth: 60, alignItems: "center" },
  tagChar: { backgroundColor: "rgba(108,92,231,0.18)" },
  tagCharText: { color: colors.primary, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  tagNarr: { backgroundColor: colors.elevated, minWidth: 36 },
  lineText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 19 },
  lineTextNarr: { color: colors.textSecondary, fontStyle: "italic" },

  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end", zIndex: 100 },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.xxl, borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xxl,
    borderTopWidth: 1, borderColor: colors.cardBorder,
  },
  sheetLine: { color: colors.text, fontSize: 15, fontStyle: "italic", marginBottom: spacing.lg },
  sheetLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginBottom: spacing.sm },
  roleBtn: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  roleBtnText: { color: colors.text, fontSize: 15, fontWeight: "600", flex: 1 },
  splitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: spacing.lg, paddingVertical: 12, borderRadius: radius.lg, backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.cardBorder },
  splitBtnText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  cancelBtn: { alignItems: "center", paddingVertical: 14, marginTop: spacing.sm },
  cancelText: { color: colors.textSecondary, fontSize: 15, fontWeight: "600" },
});
