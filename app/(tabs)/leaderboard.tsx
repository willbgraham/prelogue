import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ScrollView,
  Image,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { GENRES } from "@/lib/constants";
import { LeaderboardRowSkeleton } from "@/components/Skeleton";
import { ErrorState } from "@/components/ErrorState";
import { colors, radius, spacing } from "@/lib/theme";

type LeaderEntry = {
  actor_id: string;
  display_name: string;
  avatar_url: string | null;
  writers_choice_count: number;
  genre_choice_count?: number;
  recent_choice_count?: number;
};

const TABS = ["All", ...GENRES] as const;

export default function LeaderboardScreen() {
  const router = useRouter();
  const [selectedGenre, setSelectedGenre] = useState("All");
  const [actors, setActors] = useState<LeaderEntry[]>([]);
  const [risingStars, setRisingStars] = useState<LeaderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  async function fetchData() {
    try {
      if (selectedGenre === "All") {
        const { data, error: queryError } = await supabase
          .from("users")
          .select("id, display_name, avatar_url, writers_choice_count")
          .eq("role", "actor")
          .gt("writers_choice_count", 0)
          .order("writers_choice_count", { ascending: false })
          .limit(50);

        if (queryError) throw queryError;
        setActors(
          (data || []).map((a: any) => ({
            actor_id: a.id,
            display_name: a.display_name,
            avatar_url: a.avatar_url,
            writers_choice_count: a.writers_choice_count,
          }))
        );
      } else {
        const { data, error: queryError } = await supabase
          .from("genre_leaderboard")
          .select("*")
          .eq("genre", selectedGenre)
          .order("genre_choice_count", { ascending: false })
          .limit(50);

        if (queryError) throw queryError;
        setActors(data || []);
      }

      // Rising stars — supplementary, only rendered when populated.
      const { data: stars } = await supabase
        .from("rising_stars")
        .select("*")
        .limit(10);

      setRisingStars(stars || []);
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
  }, [selectedGenre]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [selectedGenre]);

  const rankColors = [colors.yellow, "#C0C0C0", colors.orange];

  return (
    <View style={s.container}>
      {/* Genre tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.tabsContent}
        style={s.tabsBar}
      >
        {TABS.map((genre) => (
          <TouchableOpacity
            key={genre}
            style={[s.tab, selectedGenre === genre && s.tabActive]}
            onPress={() => setSelectedGenre(genre)}
          >
            <Text style={[s.tabText, selectedGenre === genre && s.tabTextActive]}>
              {genre}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        ListHeaderComponent={
          risingStars.length > 0 ? (
            <View style={s.risingSection}>
              <View style={s.sectionRow}>
                <View style={[s.accentBar, { backgroundColor: colors.green }]} />
                <Text style={s.sectionTitle}>Rising Stars</Text>
                <Feather name="trending-up" size={16} color={colors.green} />
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.risingScroll}>
                {risingStars.map((star) => (
                  <TouchableOpacity
                    key={star.actor_id}
                    style={s.risingCard}
                    onPress={() => router.push(`/actor/${star.actor_id}` as any)}
                    activeOpacity={0.8}
                  >
                    <View style={s.risingBadge}>
                      <Feather name="zap" size={10} color={colors.green} />
                    </View>
                    {star.avatar_url ? (
                      <Image source={{ uri: star.avatar_url }} style={s.risingAvatar} />
                    ) : (
                      <View style={s.risingAvatarPlaceholder}>
                        <Feather name="user" size={20} color={colors.primary} />
                      </View>
                    )}
                    <Text style={s.risingName} numberOfLines={1}>{star.display_name}</Text>
                    <Text style={s.risingCount}>{star.recent_choice_count} picks / 30d</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : null
        }
        data={loading ? [] : actors}
        keyExtractor={(item) => item.actor_id}
        ListEmptyComponent={
          loading ? (
            <View style={s.skeletonWrap}>
              {[0, 1, 2, 3, 4].map((i) => (
                <LeaderboardRowSkeleton key={i} />
              ))}
            </View>
          ) : error ? (
            <ErrorState onRetry={retry} style={s.errorState} />
          ) : (
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>
                No rankings yet for {selectedGenre}.
              </Text>
            </View>
          )
        }
        renderItem={({ item, index }) => {
          const choiceCount =
            selectedGenre === "All"
              ? item.writers_choice_count
              : item.genre_choice_count ?? 0;

          return (
            <TouchableOpacity
              style={s.row}
              onPress={() => router.push(`/actor/${item.actor_id}` as any)}
              activeOpacity={0.7}
            >
              <View
                style={[
                  s.rankCircle,
                  {
                    backgroundColor:
                      index < 3 ? (rankColors[index] + "25") : colors.elevated,
                  },
                ]}
              >
                <Text
                  style={[
                    s.rankNum,
                    { color: index < 3 ? rankColors[index] : colors.textSecondary },
                  ]}
                >
                  {index + 1}
                </Text>
              </View>
              {item.avatar_url ? (
                <Image source={{ uri: item.avatar_url }} style={s.avatar} />
              ) : (
                <View style={s.avatarPlaceholder}>
                  <Feather name="user" size={16} color={colors.textSecondary} />
                </View>
              )}
              <View style={s.nameWrap}>
                <Text style={s.name}>{item.display_name}</Text>
                {index < 3 && (
                  <View style={s.topBadge}>
                    <Feather name="award" size={10} color={rankColors[index]} />
                  </View>
                )}
              </View>
              <View style={s.countBadge}>
                <Feather name="star" size={12} color={colors.yellow} />
                <Text style={s.countText}>{choiceCount}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  // Tab bar
  tabsBar: { maxHeight: 52, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  tabsContent: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: 8 },
  tab: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.full,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#fff" },

  // Rising Stars
  risingSection: { paddingTop: spacing.xl },
  sectionRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.xl, marginBottom: spacing.md, gap: 8 },
  accentBar: { width: 3, height: 18, borderRadius: 2 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: colors.text, flex: 1 },
  risingScroll: { paddingHorizontal: spacing.xl, gap: 12, paddingBottom: spacing.xl },
  risingCard: {
    width: 110, backgroundColor: colors.card, borderRadius: radius.xl, padding: 16,
    alignItems: "center", borderWidth: 1, borderColor: colors.cardBorder,
  },
  risingBadge: {
    position: "absolute", top: 8, right: 8,
    backgroundColor: colors.greenMuted, borderRadius: 8, padding: 4,
  },
  risingAvatar: { width: 48, height: 48, borderRadius: 24 },
  risingAvatarPlaceholder: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: colors.primaryMuted, alignItems: "center", justifyContent: "center",
  },
  risingName: { color: colors.text, fontSize: 12, fontWeight: "600", marginTop: 8, textAlign: "center" },
  risingCount: { color: colors.green, fontSize: 10, fontWeight: "700", marginTop: 2 },

  // Leaderboard rows
  skeletonWrap: { marginHorizontal: spacing.xl, backgroundColor: colors.card, borderRadius: radius.xxl, borderWidth: 1, borderColor: colors.cardBorder, overflow: "hidden" },
  emptyWrap: { padding: spacing.xxxl, alignItems: "center" },
  errorState: { marginTop: spacing.xxxl },
  emptyText: { color: colors.textSecondary, fontSize: 15 },
  row: {
    flexDirection: "row", alignItems: "center",
    marginHorizontal: spacing.xl, padding: spacing.lg,
    backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
  },
  rankCircle: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", marginRight: spacing.md },
  rankNum: { fontWeight: "700", fontSize: 14 },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: spacing.md },
  avatarPlaceholder: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.cardBorder,
    alignItems: "center", justifyContent: "center", marginRight: spacing.md,
  },
  nameWrap: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  name: { color: colors.text, fontWeight: "600", fontSize: 15 },
  topBadge: { backgroundColor: colors.yellowMuted, borderRadius: 8, padding: 3 },
  countBadge: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.yellowMuted, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.full, gap: 4,
  },
  countText: { color: colors.yellow, fontSize: 12, fontWeight: "700" },
});
