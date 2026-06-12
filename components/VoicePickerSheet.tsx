import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { Audio } from "expo-av";
import type { VoiceCatalogItem } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

const FILTER_DEFS = [
  { key: "gender", label: "Gender" },
  { key: "accent", label: "Accent" },
  { key: "language", label: "Language" },
];
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", hi: "Hindi", ja: "Japanese", ko: "Korean", zh: "Chinese",
};
const cap = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);
const displayValue = (key: string, val: string) =>
  key === "language" ? LANGUAGE_NAMES[val] ?? val.toUpperCase() : cap(val);

interface Props {
  visible: boolean;
  targetLabel: string;
  voices: VoiceCatalogItem[];
  selectedVoiceId: string | null;
  onSelect: (voice: VoiceCatalogItem) => void;
  onClose: () => void;
}

/**
 * Custom bottom-sheet voice picker (the app has no RN Modal). Lists the
 * ElevenLabs catalog with free preview playback via each voice's preview_url.
 */
export function VoicePickerSheet({
  visible,
  targetLabel,
  voices,
  selectedVoiceId,
  onSelect,
  onClose,
}: Props) {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string | null>>({});
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const previewRef = useRef<Audio.Sound | null>(null);

  // Distinct label values present in the catalog, for the filter chips.
  const filterOptions = useMemo(() => {
    const opts: Record<string, string[]> = {};
    for (const { key } of FILTER_DEFS) {
      const set = new Set<string>();
      for (const v of voices) {
        const val = (v.labels || {})[key];
        if (val) set.add(String(val));
      }
      opts[key] = [...set].sort();
    }
    return opts;
  }, [voices]);

  async function stopPreview() {
    if (previewRef.current) {
      await previewRef.current.unloadAsync().catch(() => {});
      previewRef.current = null;
    }
    setPreviewingId(null);
  }

  // Stop preview when the sheet closes or unmounts.
  useEffect(() => {
    if (!visible) stopPreview();
  }, [visible]);
  useEffect(() => {
    return () => {
      previewRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  async function preview(v: VoiceCatalogItem) {
    if (!v.preview_url) return;
    const wasPlaying = previewingId === v.voice_id;
    await stopPreview();
    if (wasPlaying) return; // toggle off
    try {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      setPreviewingId(v.voice_id);
      const { sound } = await Audio.Sound.createAsync(
        { uri: v.preview_url },
        { shouldPlay: true }
      );
      previewRef.current = sound;
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) setPreviewingId(null);
      });
    } catch {
      setPreviewingId(null);
    }
  }

  if (!visible) return null;

  const q = search.trim().toLowerCase();
  const filtered = voices.filter((v) => {
    if (
      q &&
      !v.name.toLowerCase().includes(q) &&
      !Object.values(v.labels || {}).some((l) => String(l).toLowerCase().includes(q))
    ) {
      return false;
    }
    for (const { key } of FILTER_DEFS) {
      const sel = filters[key];
      if (sel && String((v.labels || {})[key] ?? "").toLowerCase() !== sel.toLowerCase()) {
        return false;
      }
    }
    return true;
  });
  const hasActiveFilter = !!q || Object.values(filters).some(Boolean);

  return (
    <View style={s.overlay}>
      <TouchableOpacity style={s.scrim} activeOpacity={1} onPress={onClose} />
      <View style={s.panel}>
        <View style={s.handle} />
        <View style={s.headerRow}>
          <Text style={s.title} numberOfLines={1}>
            Voice for {targetLabel}
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="x" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        <View style={s.searchWrap}>
          <Feather name="search" size={16} color={colors.textMuted} />
          <TextInput
            style={s.search}
            placeholder="Search voices..."
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
        </View>

        {/* Filter chips by gender / accent / language */}
        {FILTER_DEFS.map(({ key, label }) =>
          (filterOptions[key]?.length ?? 0) > 1 ? (
            <View key={key} style={s.filterRow}>
              <Text style={s.filterLabel}>{label}</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.filterChips}
                keyboardShouldPersistTaps="handled"
              >
                {filterOptions[key].map((val) => {
                  const active = filters[key] === val;
                  return (
                    <TouchableOpacity
                      key={val}
                      style={[s.filterChip, active && s.filterChipActive]}
                      onPress={() => setFilters((p) => ({ ...p, [key]: active ? null : val }))}
                    >
                      <Text style={[s.filterChipText, active && s.filterChipTextActive]}>
                        {displayValue(key, val)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          ) : null
        )}

        <View style={s.resultRow}>
          <Text style={s.resultCount}>
            {filtered.length} voice{filtered.length === 1 ? "" : "s"}
          </Text>
          {hasActiveFilter && (
            <TouchableOpacity onPress={() => { setSearch(""); setFilters({}); }}>
              <Text style={s.clearText}>Clear all</Text>
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(v) => v.voice_id}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          windowSize={11}
          renderItem={({ item }) => {
            const selected = item.voice_id === selectedVoiceId;
            const labels = Object.values(item.labels || {}).slice(0, 3);
            const isPreviewing = previewingId === item.voice_id;
            return (
              <TouchableOpacity
                style={[s.row, selected && s.rowSelected]}
                onPress={() => onSelect(item)}
                activeOpacity={0.7}
              >
                <TouchableOpacity
                  style={s.playBtn}
                  onPress={() => preview(item)}
                  disabled={!item.preview_url}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather
                    name={isPreviewing ? "square" : "play"}
                    size={14}
                    color={item.preview_url ? colors.primary : colors.textMuted}
                  />
                </TouchableOpacity>
                <View style={s.rowContent}>
                  <Text style={s.voiceName}>{item.name}</Text>
                  {(labels.length > 0 || item.public_owner_id) && (
                    <View style={s.labelRow}>
                      {item.public_owner_id && (
                        <View style={[s.labelChip, s.libraryChip]}>
                          <Text style={[s.labelChipText, s.libraryChipText]}>＋ library</Text>
                        </View>
                      )}
                      {labels.map((l, i) => (
                        <View key={i} style={s.labelChip}>
                          <Text style={s.labelChipText}>{String(l)}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
                {selected && <Feather name="check-circle" size={18} color={colors.primary} />}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<Text style={s.empty}>No voices found.</Text>}
        />

        <TouchableOpacity style={s.doneBtn} onPress={onClose} activeOpacity={0.85}>
          <Text style={s.doneBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end", zIndex: 100 },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)" },
  panel: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    maxHeight: "85%",
    borderTopWidth: 1,
    borderColor: colors.cardBorder,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.cardBorder, marginBottom: spacing.md },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  title: { color: colors.text, fontSize: 18, fontWeight: "700", flex: 1, marginRight: spacing.md },
  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: colors.elevated, borderRadius: radius.lg,
    paddingHorizontal: spacing.md, paddingVertical: 10, marginBottom: spacing.md,
  },
  search: { flex: 1, color: colors.text, fontSize: 15, padding: 0 },
  filterRow: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm, gap: spacing.sm },
  filterLabel: { color: colors.textMuted, fontSize: 10, fontWeight: "700", width: 58, letterSpacing: 0.5, textTransform: "uppercase" },
  filterChips: { gap: 6, paddingRight: spacing.md },
  filterChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full,
    backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.cardBorder,
  },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  filterChipTextActive: { color: "#fff" },
  resultRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  resultCount: { color: colors.textMuted, fontSize: 12 },
  clearText: { color: colors.primary, fontSize: 12, fontWeight: "600" },
  row: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    paddingVertical: spacing.md, paddingHorizontal: spacing.sm,
    borderRadius: radius.md, borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
  },
  rowSelected: { backgroundColor: colors.primaryMuted },
  playBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.elevated, alignItems: "center", justifyContent: "center",
  },
  rowContent: { flex: 1 },
  voiceName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  labelRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  labelChip: { backgroundColor: colors.elevated, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2 },
  labelChipText: { color: colors.textSecondary, fontSize: 10, textTransform: "capitalize" },
  libraryChip: { backgroundColor: colors.primaryMuted },
  libraryChipText: { color: colors.primary, fontWeight: "700" },
  empty: { color: colors.textMuted, textAlign: "center", paddingVertical: spacing.xxxl },
  doneBtn: {
    backgroundColor: colors.primary, borderRadius: radius.xl,
    paddingVertical: spacing.md, alignItems: "center", marginTop: spacing.md,
  },
  doneBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
