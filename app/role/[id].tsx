import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import type { Character, Submission } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import { colors, radius, spacing } from "@/lib/theme";
import { VoteButton } from "@/components/VoteButton";
import { SubmissionMedia } from "@/components/SubmissionMedia";
import { reportContent, blockUser, getBlockedIds } from "@/lib/moderation";

export default function RoleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const [character, setCharacter] = useState<Character | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [id]);

  async function fetchData() {
    const { data: charData } = await supabase
      .from("characters")
      .select("*, script:scripts!characters_script_id_fkey(id, title, genre, status, submission_deadline)")
      .eq("id", id)
      .single();

    if (charData) setCharacter(charData as any);

    const { data: subData } = await supabase
      .from("submissions")
      .select("*, actor:users!submissions_actor_id_fkey(id, display_name, avatar_url, writers_choice_count)")
      .eq("character_id", id)
      .order("created_at", { ascending: false });

    const blocked = await getBlockedIds();
    const visible = ((subData as any[]) ?? []).filter(
      (sb) => !blocked.has(sb.actor?.id ?? sb.actor_id)
    );
    setSubmissions(visible as any);
    setLoading(false);
  }

  if (loading || !character) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const script = (character as any).script;
  const isOpen = script?.status === "open" && new Date(script.submission_deadline) > new Date();

  return (
    <>
      <Stack.Screen options={{ title: character.name, headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
      <ScrollView style={s.container}>
        <View style={s.headerBlock}>
          <Text style={s.charName}>{character.name}</Text>
          {character.description && (
            <Text style={s.charDesc}>{character.description}</Text>
          )}
          <View style={s.charMeta}>
            <Text style={s.metaLines}>{character.line_count} lines</Text>
            <Text style={s.metaScript}>
              {script?.title}
            </Text>
          </View>
        </View>

        {profile?.role === "actor" && isOpen && (
          <TouchableOpacity
            style={s.auditionBtn}
            onPress={() => router.push(`/recording/${character.id}` as any)}
          >
            <Text style={s.auditionBtnText}>Record Audition</Text>
          </TouchableOpacity>
        )}

        <View style={s.subsSection}>
          <View style={s.sectionHeader}>
            <View style={s.sectionAccent} />
            <Text style={s.sectionTitle}>
              Submissions ({submissions.length})
            </Text>
          </View>

          {submissions.length === 0 && (
            <Text style={s.noSubsText}>
              No submissions yet. Be the first!
            </Text>
          )}

          {submissions.map((sub) => (
            <View
              key={sub.id}
              style={s.subCard}
            >
              <View style={s.subRow}>
                {(sub as any).actor?.avatar_url ? (
                  <Image
                    source={{ uri: (sub as any).actor.avatar_url }}
                    style={s.subAvatar}
                  />
                ) : (
                  <View style={s.subAvatarPlaceholder}>
                    <Feather name="user" size={16} color={colors.primary} />
                  </View>
                )}
                <View style={s.subContent}>
                  <Text style={s.subActorName}>
                    {(sub as any).actor?.display_name ?? "Actor"}
                  </Text>
                  <Text style={s.subMeta}>
                    Take #{sub.take_number} &middot;{" "}
                    {formatDistanceToNow(new Date(sub.created_at), { addSuffix: true })}
                  </Text>
                </View>
                {sub.is_writers_choice && (
                  <View style={s.wcBadge}>
                    <Text style={s.wcBadgeText}>
                      Writer's Choice
                    </Text>
                  </View>
                )}
              </View>
              <SubmissionMedia submission={sub} aspectRatio={9 / 16} />
              <View style={{ marginTop: 8 }}>
                <VoteButton submissionId={sub.id} initialVoteCount={sub.vote_count} />
              </View>
              <View style={s.modRow}>
                <TouchableOpacity style={s.modBtn} onPress={() => reportContent("submission", sub.id)} hitSlop={8}>
                  <Feather name="flag" size={12} color={colors.textMuted} />
                  <Text style={s.modText}>Report</Text>
                </TouchableOpacity>
                {(sub as any).actor?.id && (sub as any).actor.id !== profile?.id && (
                  <TouchableOpacity
                    style={s.modBtn}
                    onPress={() =>
                      blockUser((sub as any).actor.id, (sub as any).actor.display_name ?? "this user", fetchData)
                    }
                    hitSlop={8}
                  >
                    <Feather name="slash" size={12} color={colors.textMuted} />
                    <Text style={s.modText}>Block</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          ))}
        </View>
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
  headerBlock: {
    backgroundColor: colors.card,
    padding: spacing.xxl,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  charName: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.text,
  },
  charDesc: {
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  charMeta: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
  },
  metaLines: {
    fontSize: 14,
    color: colors.textMuted,
  },
  metaScript: {
    fontSize: 14,
    color: colors.primary,
    marginLeft: spacing.md,
  },
  auditionBtn: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    alignItems: "center",
  },
  auditionBtnText: {
    color: colors.text,
    fontWeight: "600",
  },
  subsSection: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xxl,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  sectionAccent: {
    width: 4,
    height: 20,
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    marginRight: 10,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
  },
  noSubsText: {
    color: colors.textMuted,
    textAlign: "center",
    paddingVertical: spacing.xxxl,
  },
  subCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  subAvatar: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    marginRight: spacing.md,
  },
  subAvatarPlaceholder: {
    width: 40,
    height: 40,
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
  subMeta: {
    fontSize: 12,
    color: colors.textMuted,
  },
  wcBadge: {
    backgroundColor: colors.yellowMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  wcBadgeText: {
    color: colors.yellow,
    fontSize: 12,
    fontWeight: "500",
  },
  voteRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
  },
  voteText: {
    fontSize: 12,
    color: colors.textMuted,
    marginLeft: 4,
  },
  modRow: { flexDirection: "row", gap: spacing.lg, marginTop: 10 },
  modBtn: { flexDirection: "row", alignItems: "center", gap: 5 },
  modText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
});
