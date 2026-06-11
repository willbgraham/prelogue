import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { SCRIPT_STATUS_LABELS } from "@/lib/constants";
import { ErrorState } from "@/components/ErrorState";
import { colors as themeColors, radius, spacing } from "@/lib/theme";

const statusColors: Record<string, { bg: string; text: string }> = {
  open: { bg: themeColors.teal, text: themeColors.teal },
  casting: { bg: themeColors.yellow, text: themeColors.yellow },
  assembled: { bg: themeColors.primary, text: themeColors.primary },
  published: { bg: themeColors.green, text: themeColors.green },
};

export default function ScriptsScreen() {
  const router = useRouter();
  const { profile, session } = useAuth();
  const [scripts, setScripts] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const isWriter = profile?.role === "writer";

  async function fetchScripts() {
    let query = supabase
      .from("scripts")
      .select("*, characters(count)")
      .order("created_at", { ascending: false })
      .limit(50);

    if (isWriter && session) {
      query = query.eq("writer_id", session.user.id);
    } else {
      query = query.eq("status", "open");
    }

    try {
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      setScripts(data ?? []);
      setError(false);
    } catch (e) {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  function retry() {
    setLoading(true);
    fetchScripts();
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchScripts();
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchScripts();
  }, []);

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={themeColors.primary} />
      </View>
    );
  }

  if (error && scripts.length === 0) {
    return (
      <View style={[s.container, s.centeredContainer]}>
        <ErrorState onRetry={retry} />
      </View>
    );
  }

  return (
    <View style={s.container}>
      <FlatList
        contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={themeColors.primary} />
        }
        data={scripts}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <View style={s.headerRow}>
            <View style={s.headerAccent} />
            <Text style={s.headerTitle}>
              {isWriter ? "My Scripts" : "Browse Scripts"}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <View style={s.emptyContainer}>
            <View style={s.emptyIconBox}>
              <Feather name="file-text" size={28} color={themeColors.textMuted} />
            </View>
            <Text style={s.emptyText}>
              {isWriter
                ? "You haven't uploaded any scripts yet."
                : "No scripts available."}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const colors = statusColors[item.status] || statusColors.open;
          const charCount = item.characters?.[0]?.count ?? 0;

          return (
            <TouchableOpacity
              style={s.card}
              onPress={() => router.push(`/script/${item.id}` as any)}
              activeOpacity={0.8}
            >
              <View style={s.cardHeader}>
                <Text
                  style={s.cardTitle}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
                <View
                  style={[s.statusBadge, { backgroundColor: colors.bg + "20" }]}
                >
                  <Text
                    style={[s.statusText, { color: colors.text }]}
                  >
                    {SCRIPT_STATUS_LABELS[item.status] ?? item.status}
                  </Text>
                </View>
              </View>
              <Text style={s.logline} numberOfLines={1}>
                {item.logline}
              </Text>
              <View style={s.metaRow}>
                <Feather name="tag" size={12} color={themeColors.textMuted} />
                <Text style={s.metaText}>
                  {item.genre}
                </Text>
                <Feather name="users" size={12} color={themeColors.textMuted} />
                <Text style={s.metaTextLast}>
                  {charCount} roles
                </Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />

      {isWriter && (
        <TouchableOpacity
          style={s.fab}
          onPress={() => router.push("/script/upload" as any)}
          activeOpacity={0.85}
        >
          <Feather name="plus" size={24} color="white" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: themeColors.bg,
  },
  container: {
    flex: 1,
    backgroundColor: themeColors.bg,
  },
  centeredContainer: {
    justifyContent: "center",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.xl,
  },
  headerAccent: {
    width: 4,
    height: 20,
    backgroundColor: themeColors.primary,
    borderRadius: radius.full,
    marginRight: 10,
  },
  headerTitle: {
    color: themeColors.text,
    fontSize: 18,
    fontWeight: "700",
    flex: 1,
  },
  emptyContainer: {
    backgroundColor: themeColors.card,
    borderRadius: radius.xxl,
    padding: spacing.xxxl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: themeColors.cardBorder,
  },
  emptyIconBox: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: themeColors.elevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  emptyText: {
    color: themeColors.textSecondary,
    textAlign: "center",
    fontSize: 16,
  },
  card: {
    backgroundColor: themeColors.card,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: themeColors.cardBorder,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  cardTitle: {
    color: themeColors.text,
    fontSize: 18,
    fontWeight: "700",
    flex: 1,
    marginRight: spacing.md,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "600",
  },
  logline: {
    color: themeColors.textSecondary,
    fontSize: 14,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
  },
  metaText: {
    color: themeColors.textMuted,
    fontSize: 12,
    marginLeft: 4,
    marginRight: spacing.lg,
  },
  metaTextLast: {
    color: themeColors.textMuted,
    fontSize: 12,
    marginLeft: 4,
  },
  fab: {
    position: "absolute",
    bottom: 112,
    right: 24,
    width: 56,
    height: 56,
    backgroundColor: themeColors.primary,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
});
