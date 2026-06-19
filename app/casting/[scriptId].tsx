import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Image,
  TextInput,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { VoicePickerSheet } from "@/components/VoicePickerSheet";
import { ErrorState } from "@/components/ErrorState";
import type { Character, Submission, VoiceConfig, VoiceCatalogItem } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

interface CharacterWithSubmissions extends Character {
  submissions: Submission[];
}

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  mode: "per_character",
  single_voice_id: null,
  narrator_voice_id: null,
  characters: {},
};

export default function CastingDashboardScreen() {
  const { scriptId } = useLocalSearchParams<{ scriptId: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [characters, setCharacters] = useState<CharacterWithSubmissions[]>([]);
  const [scriptTitle, setScriptTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});

  // Voice casting
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>(DEFAULT_VOICE_CONFIG);
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalogItem[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [voicesError, setVoicesError] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<string | null>(null);
  const [addingTarget, setAddingTarget] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
    fetchVoices();
  }, [scriptId]);

  async function fetchVoices() {
    setVoicesLoading(true);
    setVoicesError(false);
    try {
      const { data, error } = await supabase.functions.invoke("list-voices", { body: {} });
      if (error) throw error;
      setVoiceCatalog((data?.voices ?? []) as VoiceCatalogItem[]);
    } catch {
      setVoicesError(true);
    } finally {
      setVoicesLoading(false);
    }
  }

  function currentVoiceFor(target: string): string | null {
    if (target === "__single__") return voiceConfig.single_voice_id ?? null;
    if (target === "__narrator__") return voiceConfig.narrator_voice_id ?? null;
    return voiceConfig.characters?.[target] ?? null;
  }

  async function persistVoiceConfig(next: VoiceConfig) {
    setVoiceConfig(next);
    const { error } = await supabase
      .from("scripts")
      .update({ voice_config: next })
      .eq("id", scriptId);
    if (error) Alert.alert("Couldn't save voices", error.message);
  }

  async function onPickVoice(target: string, voice: VoiceCatalogItem) {
    setPickerTarget(null);
    let voiceId = voice.voice_id;

    // Library voices must be added to the ElevenLabs account before they're
    // usable for TTS; swap in the resulting account voice id.
    if (voice.public_owner_id) {
      setAddingTarget(target);
      try {
        const { data, error } = await supabase.functions.invoke("add-voice", {
          body: { public_owner_id: voice.public_owner_id, voice_id: voice.voice_id, name: voice.name },
        });
        if (error) throw new Error(error.message);
        if (!data?.success || !data?.voice_id) {
          throw new Error(data?.error || "Could not add this voice.");
        }
        voiceId = data.voice_id;
        setVoiceCatalog((prev) => [
          { ...voice, voice_id: voiceId, public_owner_id: null },
          ...prev.filter((v) => v.voice_id !== voice.voice_id),
        ]);
      } catch (e: any) {
        Alert.alert(
          "Couldn't add voice",
          e?.message ?? "Try another voice, or check your ElevenLabs plan's voice limit."
        );
        setAddingTarget(null);
        return;
      }
      setAddingTarget(null);
    }

    const next: VoiceConfig = { ...voiceConfig, updated_at: new Date().toISOString() };
    if (target === "__single__") next.single_voice_id = voiceId;
    else if (target === "__narrator__") next.narrator_voice_id = voiceId;
    else next.characters = { ...(voiceConfig.characters || {}), [target]: voiceId };
    persistVoiceConfig(next);
  }

  function voiceLabel(id: string | null): string {
    if (!id) return "Choose voice";
    return voiceCatalog.find((v) => v.voice_id === id)?.name ?? "Selected voice";
  }

  function voiceDisplay(target: string): string {
    if (addingTarget === target) return "Adding…";
    return voiceLabel(currentVoiceFor(target));
  }

  function pickerLabelFor(target: string): string {
    if (target === "__single__") return "All characters & narration";
    if (target === "__narrator__") return "Narrator";
    return target;
  }

  async function fetchData() {
    const { data: scriptData } = await supabase
      .from("scripts")
      .select("title, writer_id, voice_config")
      .eq("id", scriptId)
      .single();

    if (scriptData) {
      // Verify ownership
      if (scriptData.writer_id !== session?.user.id) {
        Alert.alert("Unauthorized", "You can only cast your own scripts.");
        router.back();
        return;
      }
      setScriptTitle(scriptData.title);
      if (scriptData.voice_config) {
        setVoiceConfig({ ...DEFAULT_VOICE_CONFIG, ...(scriptData.voice_config as any) });
      }
    }

    const { data: charData } = await supabase
      .from("characters")
      .select("*, submissions(*, actor:users!submissions_actor_id_fkey(id, display_name, avatar_url))")
      .eq("script_id", scriptId)
      .order("name");

    if (charData) setCharacters(charData as any);
    setLoading(false);
  }

  async function setWritersChoice(submissionId: string, characterId: string) {
    // Clear existing choice for this character
    await supabase
      .from("submissions")
      .update({ is_writers_choice: false })
      .eq("character_id", characterId)
      .eq("is_writers_choice", true);

    // Set new choice
    await supabase
      .from("submissions")
      .update({ is_writers_choice: true })
      .eq("id", submissionId);

    // Refresh data
    fetchData();
  }

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: `Casting: ${scriptTitle}`, headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
      <ScrollView style={s.container} contentContainerStyle={{ padding: spacing.lg }}>
        {characters.map((char) => (
          <View key={char.id} style={s.charBlock}>
            <View style={s.charHeader}>
              <Text style={s.charName}>
                {char.name}
              </Text>
              <Text style={s.charSubCount}>
                {char.submissions.length} submission{char.submissions.length !== 1 ? "s" : ""}
              </Text>
            </View>

            {char.submissions.length === 0 && (
              <Text style={s.noSubsText}>No submissions yet</Text>
            )}

            {char.submissions.map((sub: any) => (
              <TouchableOpacity
                key={sub.id}
                style={[
                  s.subRow,
                  sub.is_writers_choice && s.subRowSelected,
                ]}
                onPress={() => {
                  if (char.submissions.length > 1) setWritersChoice(sub.id, char.id);
                }}
              >
                {sub.actor?.avatar_url ? (
                  <Image
                    source={{ uri: sub.actor.avatar_url }}
                    style={s.subAvatar}
                  />
                ) : (
                  <View style={s.subAvatarPlaceholder}>
                    <Feather name="user" size={18} color={colors.primary} />
                  </View>
                )}
                <View style={s.subContent}>
                  <Text style={s.subActorName}>
                    {sub.actor?.display_name ?? "Actor"}
                  </Text>
                  <Text style={s.subTake}>Take #{sub.take_number}</Text>
                </View>
                {char.submissions.length > 1 &&
                  (sub.is_writers_choice ? (
                    <View style={s.wcBadgeActive}>
                      <Text style={s.wcBadgeActiveText}>Writer's Choice</Text>
                    </View>
                  ) : (
                    <View style={s.selectBadge}>
                      <Text style={s.selectBadgeText}>Select</Text>
                    </View>
                  ))}
                {!sub.is_writers_choice && (
                  <View style={s.noteSection}>
                    <TextInput
                      style={s.noteInput}
                      placeholder="Leave a note for this actor..."
                      placeholderTextColor={colors.textMuted}
                      value={notes[sub.id] || ""}
                      onChangeText={(text) => setNotes(prev => ({...prev, [sub.id]: text}))}
                      multiline
                    />
                    {notes[sub.id]?.trim() && (
                      <TouchableOpacity
                        style={s.sendNoteBtn}
                        onPress={async () => {
                          await supabase.from("submissions").update({ writer_note: notes[sub.id].trim() }).eq("id", sub.id);
                          Alert.alert("Note Sent", "The actor will see your feedback.");
                          setNotes(prev => ({...prev, [sub.id]: ""}));
                        }}
                      >
                        <Feather name="send" size={14} color="#fff" />
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        ))}

        {/* Edit line assignments */}
        <TouchableOpacity
          style={s.editLinesBtn}
          onPress={() => router.push(`/script/edit-lines/${scriptId}` as any)}
          activeOpacity={0.85}
        >
          <Feather name="edit-3" size={15} color={colors.primary} />
          <Text style={s.editLinesText}>Edit script lines</Text>
          <Feather name="chevron-right" size={16} color={colors.textMuted} />
        </TouchableOpacity>

        {/* AI voice casting */}
        <View style={s.voicesSection}>
          <View style={s.voicesHeader}>
            <Feather name="volume-2" size={16} color={colors.primary} />
            <Text style={s.voicesTitle}>AI Voices</Text>
          </View>
          <Text style={s.voicesSub}>
            Choose the voices used when actors read along with AI.
          </Text>

          <View style={s.modeToggle}>
            <TouchableOpacity
              style={[s.modeBtn, voiceConfig.mode === "per_character" && s.modeBtnActive]}
              onPress={() => persistVoiceConfig({ ...voiceConfig, mode: "per_character" })}
            >
              <Text style={[s.modeBtnText, voiceConfig.mode === "per_character" && s.modeBtnTextActive]}>
                Per character
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modeBtn, voiceConfig.mode === "single" && s.modeBtnActive]}
              onPress={() => persistVoiceConfig({ ...voiceConfig, mode: "single" })}
            >
              <Text style={[s.modeBtnText, voiceConfig.mode === "single" && s.modeBtnTextActive]}>
                One voice
              </Text>
            </TouchableOpacity>
          </View>

          {voicesError ? (
            <ErrorState
              message="Couldn't load the voice catalog."
              onRetry={fetchVoices}
              style={{ marginHorizontal: 0 }}
            />
          ) : voicesLoading ? (
            <ActivityIndicator color={colors.primary} style={{ paddingVertical: spacing.xl }} />
          ) : voiceConfig.mode === "single" ? (
            <TouchableOpacity
              style={s.voiceRow}
              onPress={() => setPickerTarget("__single__")}
              activeOpacity={0.7}
            >
              <View style={s.voiceRowIcon}>
                <Feather name="users" size={14} color={colors.primary} />
              </View>
              <Text style={s.voiceRowLabel} numberOfLines={1}>
                All characters & narration
              </Text>
              <Text style={s.voiceRowValue} numberOfLines={1}>
                {voiceDisplay("__single__")}
              </Text>
              <Feather name="chevron-right" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ) : (
            <>
              {characters.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={s.voiceRow}
                  onPress={() => setPickerTarget(c.name.toUpperCase())}
                  activeOpacity={0.7}
                >
                  <View style={s.voiceRowIcon}>
                    <Feather name="user" size={14} color={colors.primary} />
                  </View>
                  <Text style={s.voiceRowLabel} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={s.voiceRowValue} numberOfLines={1}>
                    {voiceDisplay(c.name.toUpperCase())}
                  </Text>
                  <Feather name="chevron-right" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={s.voiceRow}
                onPress={() => setPickerTarget("__narrator__")}
                activeOpacity={0.7}
              >
                <View style={s.voiceRowIcon}>
                  <Feather name="film" size={14} color={colors.primary} />
                </View>
                <Text style={s.voiceRowLabel} numberOfLines={1}>
                  Narrator (action lines)
                </Text>
                <Text style={s.voiceRowValue} numberOfLines={1}>
                  {voiceDisplay("__narrator__")}
                </Text>
                <Feather name="chevron-right" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </>
          )}
        </View>

        <TouchableOpacity
          style={[s.assembleBtn, s.assembleBtnActive]}
          onPress={() => router.push(`/table-read/play/${scriptId}` as any)}
          activeOpacity={0.85}
        >
          <Feather name="play" size={16} color="#fff" />
          <Text style={s.assembleBtnText}>Play Table Read</Text>
        </TouchableOpacity>
      </ScrollView>

      <VoicePickerSheet
        visible={pickerTarget !== null}
        targetLabel={pickerTarget ? pickerLabelFor(pickerTarget) : ""}
        voices={voiceCatalog}
        selectedVoiceId={pickerTarget ? currentVoiceFor(pickerTarget) : null}
        onSelect={(voice) => pickerTarget && onPickVoice(pickerTarget, voice)}
        onClose={() => setPickerTarget(null)}
      />
    </>
  );
}

const s = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  charBlock: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  charHeader: {
    backgroundColor: colors.elevated,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  charName: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  charSubCount: {
    fontSize: 12,
    color: colors.textMuted,
  },
  noSubsText: {
    color: colors.textMuted,
    textAlign: "center",
    paddingVertical: spacing.xxl,
  },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  subRowSelected: {
    backgroundColor: "rgba(253, 203, 110, 0.1)",
  },
  subAvatar: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    marginRight: spacing.md,
  },
  subAvatarPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: colors.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  subContent: {
    flex: 1,
  },
  subActorName: {
    fontWeight: "600",
    color: colors.text,
  },
  subTake: {
    fontSize: 12,
    color: colors.textMuted,
  },
  wcBadgeActive: {
    backgroundColor: colors.yellow,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  wcBadgeActiveText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: "700",
  },
  selectBadge: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  selectBadgeText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  assembleBtn: {
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: spacing.lg,
  },
  assembleBtnActive: {
    backgroundColor: colors.primary,
  },
  assembleBtnDisabled: {
    backgroundColor: colors.cardBorder,
  },
  assembleBtnText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 16,
  },
  noteSection: { flexDirection: "row", alignItems: "center", marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.cardBorder },
  noteInput: { flex: 1, backgroundColor: colors.elevated, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, color: colors.text, fontSize: 13 },
  sendNoteBtn: { marginLeft: 8, backgroundColor: colors.primary, width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },

  editLinesBtn: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.cardBorder,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, marginTop: spacing.sm,
  },
  editLinesText: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  // Voices section
  voicesSection: {
    marginTop: spacing.sm, marginBottom: spacing.lg,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.cardBorder, padding: spacing.lg,
  },
  voicesHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  voicesTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  voicesSub: { color: colors.textSecondary, fontSize: 13, marginTop: 4, marginBottom: spacing.md, lineHeight: 18 },
  modeToggle: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
  modeBtn: {
    flex: 1, paddingVertical: 8, borderRadius: radius.md,
    backgroundColor: colors.elevated, alignItems: "center",
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  modeBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  modeBtnText: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
  modeBtnTextActive: { color: "#fff" },
  voiceRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.cardBorder,
  },
  voiceRowIcon: {
    width: 28, height: 28, borderRadius: radius.sm,
    backgroundColor: colors.primaryMuted, alignItems: "center", justifyContent: "center",
  },
  voiceRowLabel: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  voiceRowValue: { color: colors.textSecondary, fontSize: 13, maxWidth: 110 },
});
