import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Image,
  TouchableOpacity,
  Linking,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { FollowButton } from "@/components/FollowButton";
import type { User, Submission } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

export default function ActorProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [actor, setActor] = useState<User | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [id]);

  async function fetchData() {
    const [actorRes, subsRes] = await Promise.all([
      supabase.from("users").select("*").eq("id", id).single(),
      supabase
        .from("submissions")
        .select("*, character:characters!submissions_character_id_fkey(name), script:scripts!submissions_script_id_fkey(id, title)")
        .eq("actor_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    if (actorRes.data) setActor(actorRes.data as User);
    if (subsRes.data) setSubmissions(subsRes.data as any);
    setLoading(false);
  }

  if (loading || !actor) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: actor.display_name, headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
      <ScrollView style={s.container}>
        <View style={s.profileHeader}>
          {actor.avatar_url ? (
            <Image
              source={{ uri: actor.avatar_url }}
              style={s.avatar}
            />
          ) : (
            <View style={s.avatarPlaceholder}>
              <Feather name="user" size={36} color={colors.primary} />
            </View>
          )}
          <Text style={s.actorName}>{actor.display_name}</Text>
          <FollowButton userId={actor.id} />
          {actor.bio && (
            <Text style={s.bio}>
              {actor.bio}
            </Text>
          )}
          {(actor as any).demo_reel_url && (
            <TouchableOpacity
              style={s.demoReelBtn}
              onPress={() => Linking.openURL((actor as any).demo_reel_url)}
            >
              <Feather name="play-circle" size={16} color={colors.primary} />
              <Text style={s.demoReelText}>Watch Demo Reel</Text>
            </TouchableOpacity>
          )}
          {actor.genre_specialties && actor.genre_specialties.length > 0 && (
            <View style={s.genreRow}>
              {actor.genre_specialties.map((g) => (
                <View key={g} style={s.genreBadge}>
                  <Text style={s.genreBadgeText}>{g}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        <View style={s.statsBar}>
          <View style={s.statItem}>
            <Text style={s.statValuePrimary}>
              {actor.writers_choice_count}
            </Text>
            <Text style={s.statLabel}>Writer's Choice</Text>
          </View>
          <View style={s.statItem}>
            <Text style={s.statValueRed}>
              {actor.audience_favorite_count}
            </Text>
            <Text style={s.statLabel}>Audience Fav</Text>
          </View>
          <View style={s.statItem}>
            <Text style={s.statValueWhite}>
              {submissions.length}
            </Text>
            <Text style={s.statLabel}>Submissions</Text>
          </View>
        </View>

        <View style={s.portfolioSection}>
          <View style={s.sectionHeader}>
            <View style={s.sectionAccent} />
            <Text style={s.sectionTitle}>Portfolio</Text>
          </View>
          {submissions.map((sub) => (
            <TouchableOpacity
              key={sub.id}
              style={s.subCard}
              onPress={() => router.push(`/role/${sub.character_id}` as any)}
            >
              <Text style={s.subCharName}>
                {(sub as any).character?.name}
              </Text>
              <Text style={s.subScriptTitle}>
                {(sub as any).script?.title}
              </Text>
              <View style={s.subMeta}>
                {sub.is_writers_choice && (
                  <View style={s.wcBadge}>
                    <Text style={s.wcBadgeText}>
                      Writer's Choice
                    </Text>
                  </View>
                )}
                <Text style={s.subTake}>
                  Take #{sub.take_number}
                </Text>
              </View>
            </TouchableOpacity>
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
  profileHeader: {
    backgroundColor: colors.card,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxxl,
    paddingBottom: spacing.xxl,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: radius.full,
    marginBottom: spacing.lg,
  },
  avatarPlaceholder: {
    width: 96,
    height: 96,
    borderRadius: radius.full,
    backgroundColor: colors.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  actorName: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
  },
  bio: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  genreRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  genreBadge: {
    backgroundColor: colors.primaryMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  genreBadgeText: {
    color: colors.primary,
    fontSize: 12,
  },
  statsBar: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: colors.card,
    marginTop: spacing.sm,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  statItem: {
    alignItems: "center",
  },
  statValuePrimary: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.primary,
  },
  statValueRed: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.red,
  },
  statValueWhite: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.text,
  },
  statLabel: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  portfolioSection: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
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
  subCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  subCharName: {
    fontWeight: "600",
    color: colors.text,
  },
  subScriptTitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 2,
  },
  subMeta: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
  },
  wcBadge: {
    backgroundColor: colors.yellowMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    marginRight: spacing.sm,
  },
  wcBadgeText: {
    color: colors.yellow,
    fontSize: 12,
    fontWeight: "500",
  },
  subTake: {
    fontSize: 12,
    color: colors.textMuted,
  },
  demoReelBtn: {
    flexDirection: "row", alignItems: "center", marginTop: 12,
    backgroundColor: colors.primaryMuted, paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.full, gap: 6,
  },
  demoReelText: { color: colors.primary, fontWeight: "600", fontSize: 13 },
});
