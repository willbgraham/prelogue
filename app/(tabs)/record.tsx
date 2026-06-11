import { useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { colors, radius, spacing } from "@/lib/theme";

export default function RecordScreen() {
  const { profile } = useAuth();
  const router = useRouter();
  const [characters, setCharacters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (profile?.role !== "actor") {
      setLoading(false);
      return;
    }
    fetchOpenRoles();
  }, []);

  async function fetchOpenRoles() {
    const { data } = await supabase
      .from("characters")
      .select("*, script:scripts(id, title, genre, status, submission_deadline)")
      .limit(30);

    if (data) {
      setCharacters(
        data.filter(
          (c: any) =>
            c.script &&
            c.script.status === "open" &&
            new Date(c.script.submission_deadline) > new Date()
        )
      );
    }
    setLoading(false);
  }

  if (profile?.role !== "actor") {
    return (
      <View style={s.nonActorContainer}>
        <View style={s.nonActorIconBox}>
          <Feather name="video" size={32} color={colors.textMuted} />
        </View>
        <Text style={s.nonActorTitle}>
          Recording Studio
        </Text>
        <Text style={s.nonActorSubtitle}>
          This tab is for actors to record{"\n"}audition videos for open roles.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <FlatList
      style={s.list}
      contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100 }}
      data={characters}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View style={s.headerRow}>
          <View style={s.headerAccent} />
          <Text style={s.headerTitle}>Open Roles</Text>
        </View>
      }
      ListEmptyComponent={
        <View style={s.emptyContainer}>
          <View style={s.emptyIconBox}>
            <Feather name="mic" size={28} color={colors.textMuted} />
          </View>
          <Text style={s.emptyText}>
            No open roles right now.{"\n"}Check back soon!
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          style={s.card}
          onPress={() => router.push(`/role/${item.id}` as any)}
          activeOpacity={0.8}
        >
          <View style={s.cardRow}>
            <View style={s.roleIcon}>
              <Feather name="user" size={18} color={colors.primary} />
            </View>
            <View style={s.cardContent}>
              <Text style={s.roleName}>{item.name}</Text>
              <Text style={s.scriptTitle}>
                {item.script?.title}
              </Text>
            </View>
            <View style={s.cardRight}>
              <Text style={s.lineCount}>{item.line_count} lines</Text>
              <View style={s.genreBadge}>
                <Text style={s.genreText}>
                  {item.script?.genre}
                </Text>
              </View>
            </View>
          </View>
        </TouchableOpacity>
      )}
    />
  );
}

const s = StyleSheet.create({
  nonActorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xxxl,
  },
  nonActorIconBox: {
    width: 80,
    height: 80,
    borderRadius: radius.xxl,
    backgroundColor: colors.elevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xl,
  },
  nonActorTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.sm,
    textAlign: "center",
  },
  nonActorSubtitle: {
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 20,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  list: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.xl,
  },
  headerAccent: {
    width: 4,
    height: 20,
    backgroundColor: colors.red,
    borderRadius: radius.full,
    marginRight: 10,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  emptyContainer: {
    backgroundColor: colors.card,
    borderRadius: radius.xxl,
    padding: spacing.xxxl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  emptyIconBox: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.elevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  emptyText: {
    color: colors.textSecondary,
    textAlign: "center",
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  roleIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  cardContent: {
    flex: 1,
  },
  roleName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  scriptTitle: {
    color: colors.textSecondary,
    fontSize: 14,
    marginTop: 2,
  },
  cardRight: {
    alignItems: "flex-end",
  },
  lineCount: {
    color: colors.textMuted,
    fontSize: 12,
  },
  genreBadge: {
    backgroundColor: "rgba(0, 206, 201, 0.15)",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    marginTop: 4,
  },
  genreText: {
    color: colors.teal,
    fontSize: 12,
    fontWeight: "500",
  },
});
