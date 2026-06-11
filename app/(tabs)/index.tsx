import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { colors, radius, spacing } from "@/lib/theme";
import { ScriptCardSkeleton } from "@/components/Skeleton";
import { ErrorState } from "@/components/ErrorState";

const genreColors: Record<string, string> = {
  "Sci-Fi": "#00cec9",
  Drama: "#e17055",
  Comedy: "#fdcb6e",
  Thriller: "#d63031",
  Horror: "#6c5ce7",
  Romance: "#e84393",
  Action: "#ff7675",
  Mystery: "#a29bfe",
  Fantasy: "#55efc4",
};

export default function HomeScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const [scripts, setScripts] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [trending, setTrending] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function fetchData() {
    try {
      const [scriptsRes, leaderRes, trendingRes] = await Promise.all([
        supabase
          .from("scripts")
          .select("*, characters(count)")
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("users")
          .select("*")
          .eq("role", "actor")
          .order("writers_choice_count", { ascending: false })
          .limit(5),
        supabase
          .from("trending_reads")
          .select("*")
          .limit(5),
      ]);
      // Gate the screen on the primary content (scripts); the leaderboard and
      // trending sections fail soft since they only render when populated.
      if (scriptsRes.error) throw scriptsRes.error;
      setScripts(scriptsRes.data ?? []);
      setLeaderboard(leaderRes.data ?? []);
      setTrending(trendingRes.data ?? []);
      setError(false);
    } catch (e) {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  function retry() {
    setLoading(true);
    fetchData();
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <FlatList
      style={s.container}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
      ListHeaderComponent={
        <View>
          {/* Hero */}
          <View style={s.hero}>
            <View style={s.logoRow}>
              <View style={s.logoBox}>
                <Text style={s.logoText}>C</Text>
              </View>
              <TouchableOpacity
                style={s.bellBtn}
                onPress={() => router.push("/(tabs)/notifications" as any)}
              >
                <Feather name="bell" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
              {!profile && (
                <TouchableOpacity
                  style={s.signInBtn}
                  onPress={() => router.push("/(auth)/sign-in" as any)}
                >
                  <Text style={s.signInText}>Sign In</Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={s.heroTitle}>
              {profile ? `Welcome back,\n${profile.display_name}` : "Discover\nTable Reads"}
            </Text>
            <Text style={s.heroSub}>
              {profile
                ? "Find your next role or review auditions"
                : "Browse scripts, watch performances, discover talent"}
            </Text>
          </View>

          {/* Section: Open Auditions */}
          <View style={s.sectionHeader}>
            <View style={s.accentBar} />
            <Text style={s.sectionTitle}>Open Auditions</Text>
            {!error && (
              <Text style={s.sectionCount}>
                {scripts.length} {scripts.length === 1 ? "script" : "scripts"}
              </Text>
            )}
          </View>
        </View>
      }
      data={loading ? [] : scripts}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => {
        const charCount = item.characters?.[0]?.count ?? 0;
        const gc = genreColors[item.genre] || colors.primary;

        return (
          <TouchableOpacity
            style={s.scriptCard}
            activeOpacity={0.8}
            onPress={() => router.push(`/script/${item.id}` as any)}
          >
            {item.cover_image_url ? (
              <Image source={{ uri: item.cover_image_url }} style={s.coverImage} />
            ) : (
              <View style={[s.cardAccent, { backgroundColor: gc }]} />
            )}
            <View style={s.cardBody}>
              {/* Top row */}
              <View style={s.cardTopRow}>
                <View style={[s.genreBadge, { backgroundColor: gc + "22" }]}>
                  <Text style={[s.genreText, { color: gc }]}>{item.genre}</Text>
                </View>
                <View style={s.openBadge}>
                  <View style={s.openDot} />
                  <Text style={s.openText}>Open</Text>
                </View>
              </View>

              {/* Title */}
              <Text style={s.cardTitle}>{item.title}</Text>
              <Text style={s.cardLogline} numberOfLines={2}>
                {item.logline}
              </Text>

              {/* Footer */}
              <View style={s.cardFooter}>
                <View style={s.cardStat}>
                  <Feather name="users" size={13} color={colors.primary} />
                  <Text style={s.cardStatText}>{charCount} roles</Text>
                </View>
                <TouchableOpacity
                  style={s.viewRolesBtn}
                  onPress={() => router.push(`/script/${item.id}` as any)}
                >
                  <Text style={s.viewRolesBtnText}>View Roles</Text>
                  <Feather name="arrow-right" size={14} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={
        loading ? (
          <View style={{ paddingHorizontal: spacing.xl }}>
            <ScriptCardSkeleton />
            <ScriptCardSkeleton />
            <ScriptCardSkeleton />
          </View>
        ) : error ? (
          <ErrorState onRetry={retry} />
        ) : (
          <View style={s.emptyCard}>
            <View style={s.emptyIcon}>
              <Feather name="book-open" size={28} color={colors.textMuted} />
            </View>
            <Text style={s.emptyText}>
              No scripts open right now.{"\n"}Check back soon!
            </Text>
          </View>
        )
      }
      ListFooterComponent={
        <View>
          {trending.length > 0 && (
            <View style={s.trendingSection}>
              <View style={s.sectionHeader}>
                <View style={[s.accentBar, { backgroundColor: colors.red }]} />
                <Text style={s.sectionTitle}>Trending</Text>
                <Feather name="trending-up" size={16} color={colors.red} />
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.trendingScroll}>
                {trending.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={s.trendingCard}
                    onPress={() => router.push(`/table-read/${item.id}` as any)}
                    activeOpacity={0.8}
                  >
                    {item.cover_image_url ? (
                      <Image source={{ uri: item.cover_image_url }} style={s.trendingImage} />
                    ) : (
                      <View style={s.trendingImagePlaceholder}>
                        <Feather name="play" size={24} color={colors.textMuted} />
                      </View>
                    )}
                    <Text style={s.trendingTitle} numberOfLines={2}>{item.title}</Text>
                    <View style={s.trendingMeta}>
                      <Feather name="eye" size={10} color={colors.textMuted} />
                      <Text style={s.trendingViews}>{item.view_count} views</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}
          {leaderboard.length > 0 && (
            <View style={s.leaderSection}>
              <View style={s.sectionHeader}>
                <View style={[s.accentBar, { backgroundColor: colors.yellow }]} />
                <Text style={s.sectionTitle}>Top Actors</Text>
              </View>
              <View style={s.leaderCard}>
                {leaderboard.map((actor, idx) => (
                  <TouchableOpacity
                    key={actor.id}
                    style={[
                      s.leaderRow,
                      idx < leaderboard.length - 1 && s.leaderRowBorder,
                    ]}
                    onPress={() => router.push(`/actor/${actor.id}` as any)}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        s.rankCircle,
                        {
                          backgroundColor:
                            idx === 0
                              ? colors.yellowMuted
                              : idx === 1
                              ? "rgba(223,230,233,0.2)"
                              : idx === 2
                              ? colors.redMuted
                              : colors.elevated,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          s.rankText,
                          {
                            color:
                              idx === 0
                                ? colors.yellow
                                : idx === 1
                                ? "#dfe6e9"
                                : idx === 2
                                ? colors.orange
                                : colors.textSecondary,
                          },
                        ]}
                      >
                        {idx + 1}
                      </Text>
                    </View>
                    <View style={s.leaderAvatar}>
                      <Feather name="user" size={16} color={colors.textSecondary} />
                    </View>
                    <Text style={s.leaderName}>{actor.display_name}</Text>
                    <View style={s.awardBadge}>
                      <Feather name="award" size={12} color={colors.yellow} />
                      <Text style={s.awardText}>{actor.writers_choice_count}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
        </View>
      }
    />
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },

  // Hero
  hero: { paddingHorizontal: spacing.xl, paddingTop: 60, paddingBottom: spacing.xl },
  logoRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.lg, gap: 12 },
  logoBox: {
    width: 44, height: 44, borderRadius: radius.md,
    backgroundColor: colors.primary, alignItems: "center", justifyContent: "center",
  },
  logoText: { color: "#fff", fontSize: 22, fontWeight: "800" },
  bellBtn: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder, alignItems: "center", justifyContent: "center" },
  signInBtn: {
    backgroundColor: colors.primaryMuted, paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: radius.full,
  },
  signInText: { color: colors.primary, fontWeight: "700", fontSize: 14 },
  heroTitle: { fontSize: 32, fontWeight: "800", color: colors.text, lineHeight: 40 },
  heroSub: { fontSize: 15, color: colors.textSecondary, marginTop: 8, lineHeight: 22 },

  // Section headers
  sectionHeader: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: spacing.xl, marginBottom: spacing.lg, marginTop: spacing.sm,
  },
  accentBar: { width: 3, height: 20, backgroundColor: colors.primary, borderRadius: 2, marginRight: 10 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: colors.text, flex: 1 },
  sectionCount: { fontSize: 13, fontWeight: "600", color: colors.primary },

  // Script card
  scriptCard: {
    marginHorizontal: spacing.xl, marginBottom: spacing.lg,
    backgroundColor: colors.card, borderRadius: radius.xxl,
    borderWidth: 1, borderColor: colors.cardBorder, overflow: "hidden",
  },
  coverImage: { width: "100%", height: 160 },
  cardAccent: { height: 3 },
  cardBody: { padding: spacing.xl },
  cardTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  genreBadge: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.full },
  genreText: { fontSize: 12, fontWeight: "700" },
  openBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  openDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green },
  openText: { color: colors.green, fontSize: 12, fontWeight: "600" },
  cardTitle: { fontSize: 22, fontWeight: "800", color: colors.text, marginBottom: 8 },
  cardLogline: { fontSize: 14, color: colors.textSecondary, lineHeight: 20, marginBottom: spacing.lg },
  cardFooter: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.cardBorder,
  },
  cardStat: { flexDirection: "row", alignItems: "center" },
  cardStatText: { color: "#c4c4d4", fontSize: 13, marginLeft: 6, fontWeight: "500" },
  viewRolesBtn: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: radius.lg, gap: 6,
  },
  viewRolesBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },

  // Empty
  emptyCard: {
    marginHorizontal: spacing.xl, backgroundColor: colors.card, borderRadius: radius.xxl,
    padding: spacing.xxxl, alignItems: "center", borderWidth: 1, borderColor: colors.cardBorder,
  },
  emptyIcon: {
    width: 64, height: 64, borderRadius: radius.xl, backgroundColor: colors.elevated,
    alignItems: "center", justifyContent: "center", marginBottom: spacing.lg,
  },
  emptyText: { color: colors.textSecondary, textAlign: "center", fontSize: 15, lineHeight: 22 },

  // Trending
  trendingSection: { marginTop: spacing.xxl },
  trendingScroll: { paddingHorizontal: spacing.xl, gap: 12, paddingBottom: 8 },
  trendingCard: { width: 160, backgroundColor: colors.card, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.cardBorder, overflow: "hidden" },
  trendingImage: { width: "100%", height: 90 },
  trendingImagePlaceholder: { width: "100%", height: 90, backgroundColor: colors.elevated, alignItems: "center", justifyContent: "center" },
  trendingTitle: { color: colors.text, fontSize: 13, fontWeight: "600", padding: 10, paddingBottom: 4 },
  trendingMeta: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingBottom: 10, gap: 4 },
  trendingViews: { color: colors.textMuted, fontSize: 11 },

  // Leaderboard
  leaderSection: { marginTop: spacing.xxl },
  leaderCard: {
    marginHorizontal: spacing.xl, backgroundColor: colors.card,
    borderRadius: radius.xxl, borderWidth: 1, borderColor: colors.cardBorder, overflow: "hidden",
  },
  leaderRow: { flexDirection: "row", alignItems: "center", padding: spacing.lg },
  leaderRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  rankCircle: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center", marginRight: spacing.md,
  },
  rankText: { fontWeight: "700", fontSize: 14 },
  leaderAvatar: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.cardBorder,
    alignItems: "center", justifyContent: "center", marginRight: spacing.md,
  },
  leaderName: { color: colors.text, fontWeight: "600", fontSize: 15, flex: 1 },
  awardBadge: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.yellowMuted, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.full,
  },
  awardText: { color: colors.yellow, fontSize: 12, fontWeight: "700", marginLeft: 4 },
});
