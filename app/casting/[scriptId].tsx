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
import type { Character, Submission } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

interface CharacterWithSubmissions extends Character {
  submissions: Submission[];
}

export default function CastingDashboardScreen() {
  const { scriptId } = useLocalSearchParams<{ scriptId: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [characters, setCharacters] = useState<CharacterWithSubmissions[]>([]);
  const [scriptTitle, setScriptTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [assembling, setAssembling] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchData();
  }, [scriptId]);

  async function fetchData() {
    const { data: scriptData } = await supabase
      .from("scripts")
      .select("title, writer_id")
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

  async function handleAssemble() {
    const allCast = characters.every((c) =>
      c.submissions.some((s) => s.is_writers_choice)
    );

    if (!allCast) {
      Alert.alert("Not Ready", "Please select a Writer's Choice for every character.");
      return;
    }

    setAssembling(true);
    try {
      await supabase
        .from("scripts")
        .update({ status: "casting" })
        .eq("id", scriptId);

      const { error: readError } = await supabase
        .from("assembled_reads")
        .insert({ script_id: scriptId, status: "processing" });

      if (readError) throw readError;

      const { error: fnError } = await supabase.functions.invoke("assemble-video", {
        body: { script_id: scriptId },
      });

      if (fnError) console.warn("Assembly function error:", fnError);

      Alert.alert(
        "Assembly Started",
        "Your table read is being assembled. You'll be notified when it's ready!",
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setAssembling(false);
    }
  }

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const allCast = characters.every((c) =>
    c.submissions.some((s) => s.is_writers_choice)
  );

  return (
    <>
      <Stack.Screen options={{ title: `Cast: ${scriptTitle}`, headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
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
                onPress={() => setWritersChoice(sub.id, char.id)}
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
                {sub.is_writers_choice ? (
                  <View style={s.wcBadgeActive}>
                    <Text style={s.wcBadgeActiveText}>
                      Writer's Choice
                    </Text>
                  </View>
                ) : (
                  <View style={s.selectBadge}>
                    <Text style={s.selectBadgeText}>Select</Text>
                  </View>
                )}
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

        <TouchableOpacity
          style={[
            s.assembleBtn,
            allCast && !assembling ? s.assembleBtnActive : s.assembleBtnDisabled,
          ]}
          onPress={handleAssemble}
          disabled={!allCast || assembling}
        >
          {assembling ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={s.assembleBtnText}>
              Assemble Table Read
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>
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
    alignItems: "center",
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
});
