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
import { colors, radius, spacing, genreColors } from "@/lib/theme";
import { ScriptCardSkeleton } from "@/components/Skeleton";
import { ErrorState } from "@/components/ErrorState";
import { getBlockedIds } from "@/lib/moderation";

const HOW_STEPS = [
  { h: "Upload", t: "A writer adds a screenplay — it's parsed into scenes, characters, and lines." },
  { h: "Hear it", t: "Press play and AI voices perform the whole script, with the narration typed on screen." },
  { h: "Showcase", t: "Actors record reads for any role; audiences watch and champion the best." },
];
const WRITER_POINTS = [
  "Hear your script performed instantly",
  "Cast a voice per character",
  "Collect real actor reads",
  "Copyright + treatment on file",
];
const ACTOR_POINTS = [
  "Showcase your talent through table reads",
  "Perform with AI voices",
  "Earn Writer's Choice / Audience Favorite",
];

const intro = StyleSheet.create({
  card: {
    marginHorizontal: spacing.xl, marginTop: spacing.lg, backgroundColor: colors.card,
    borderRadius: radius.xl, borderWidth: 1, borderColor: colors.cardBorder, padding: spacing.xl,
  },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  title: { color: colors.text, fontSize: 18, fontFamily: "RobotoSlab_700Bold", lineHeight: 24 },
  tagline: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 6 },
  sectionLabel: {
    color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1.5,
    marginTop: spacing.xl, marginBottom: spacing.md,
  },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: spacing.md },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primaryMuted, alignItems: "center", justifyContent: "center" },
  stepNumText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  stepText: { flex: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  bold: { color: colors.text, fontWeight: "700" },
  col: { backgroundColor: colors.elevated, borderRadius: radius.lg, padding: spacing.lg, marginTop: spacing.md },
  colHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.sm },
  colTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  point: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 18, marginBottom: 5 },
});

export default function HomeScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const [scripts, setScripts] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [trending, setTrending] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [introOpen, setIntroOpen] = useState(true);

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
      const blocked = await getBlockedIds();
      setScripts(
        ((scriptsRes.data as any[]) ?? []).filter(
          (sc) => !blocked.has(sc.writer_id) && (sc.visibility ?? "public") === "public"
        )
      );
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
                <Text style={s.logoText}>P</Text>
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
                ? "Find a script to read — or hear yours performed"
                : "Hear screenplays performed — by AI voices and real actors"}
            </Text>
          </View>

          {/* What is Prelogue — explainer (collapsible) */}
          <View style={intro.card}>
            <TouchableOpacity style={intro.head} onPress={() => setIntroOpen((v) => !v)} activeOpacity={0.8}>
              <View style={{ flex: 1 }}>
                <Text style={intro.title}>Where screenplays come to life</Text>
                <Text style={intro.tagline}>
                  Prelogue turns a script into a performed table read (AI voices and/or real actors).
                </Text>
              </View>
              <Feather name={introOpen ? "chevron-up" : "chevron-down"} size={20} color={colors.textMuted} />
            </TouchableOpacity>

            {introOpen && (
              <>
                <Text style={intro.sectionLabel}>HOW IT WORKS</Text>
                {HOW_STEPS.map((st, i) => (
                  <View key={st.h} style={intro.step}>
                    <View style={intro.stepNum}>
                      <Text style={intro.stepNumText}>{i + 1}</Text>
                    </View>
                    <Text style={intro.stepText}>
                      <Text style={intro.bold}>{st.h}.</Text> {st.t}
                    </Text>
                  </View>
                ))}

                <View style={intro.col}>
                  <View style={intro.colHead}>
                    <Feather name="edit-3" size={14} color={colors.primary} />
                    <Text style={intro.colTitle}>For Writers</Text>
                  </View>
                  {WRITER_POINTS.map((p) => (
                    <Text key={p} style={intro.point}>•  {p}</Text>
                  ))}
                </View>

                <View style={intro.col}>
                  <View style={intro.colHead}>
                    <Feather name="video" size={14} color={colors.teal} />
                    <Text style={intro.colTitle}>For Actors</Text>
                  </View>
                  {ACTOR_POINTS.map((p) => (
                    <Text key={p} style={intro.point}>•  {p}</Text>
                  ))}
                </View>
              </>
            )}
          </View>

          {/* Section: Featured Scripts */}
          <View style={s.sectionHeader}>
            <View style={s.accentBar} />
            <Text style={s.sectionTitle}>Featured Scripts</Text>
            {!error && !loading && (
              <TouchableOpacity
                onPress={() => router.push("/(tabs)/scripts" as any)}
                style={{ marginLeft: "auto" }}
                activeOpacity={0.7}
              >
                <Text style={{ color: colors.primary, fontSize: 13, fontWeight: "700" }}>View all →</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      }
      data={loading ? [] : scripts.slice(0, 3)}
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
  logoText: { color: "#fff", fontSize: 22, fontFamily: "RobotoSlab_700Bold" },
  bellBtn: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder, alignItems: "center", justifyContent: "center" },
  signInBtn: {
    backgroundColor: colors.primaryMuted, paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: radius.full,
  },
  signInText: { color: colors.primary, fontWeight: "700", fontSize: 14 },
  heroTitle: { fontSize: 32, fontFamily: "RobotoSlab_700Bold", color: colors.text, lineHeight: 40 },
  heroSub: { fontSize: 15, color: colors.textSecondary, marginTop: 8, lineHeight: 22 },

  // Section headers
  sectionHeader: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: spacing.xl, marginBottom: spacing.lg, marginTop: spacing.sm,
  },
  accentBar: { width: 3, height: 20, backgroundColor: colors.primary, borderRadius: 2, marginRight: 10 },
  sectionTitle: { fontSize: 18, fontFamily: "RobotoSlab_700Bold", color: colors.text, flex: 1 },
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
  cardTitle: { fontSize: 22, fontFamily: "RobotoSlab_700Bold", color: colors.text, marginBottom: 8 },
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
