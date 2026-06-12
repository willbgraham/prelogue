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
import { useRequireAuth } from "@/lib/useRequireAuth";
import { SCRIPT_STATUS_LABELS } from "@/lib/constants";
import { colors, radius, spacing } from "@/lib/theme";

export default function ScriptDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const { requireAuth } = useRequireAuth();
  const [script, setScript] = useState<any>(null);
  const [characters, setCharacters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchScript();
  }, [id]);

  async function fetchScript() {
    const [scriptRes, charRes] = await Promise.all([
      supabase.from("scripts").select("*").eq("id", id).single(),
      supabase
        .from("characters")
        .select("*, submissions(count)")
        .eq("script_id", id)
        .order("line_count", { ascending: false }),
    ]);

    if (scriptRes.data) setScript(scriptRes.data);
    if (charRes.data) {
      setCharacters(
        charRes.data.map((c: any) => ({
          ...c,
          submission_count: c.submissions?.[0]?.count ?? 0,
        }))
      );
    }
    setLoading(false);
  }

  function openScript() {
    router.push(`/script/read?id=${script.id}` as any);
  }

  if (loading || !script) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const isOwner = session?.user?.id === script.writer_id;
  const isOpen = script.status === "open";

  const genreColorMap: Record<string, string> = {
    "Sci-Fi": colors.teal,
    Drama: "#e17055",
    Comedy: colors.yellow,
    Thriller: "#d63031",
    Horror: colors.primary,
    Romance: "#e84393",
    Action: colors.red,
  };
  const genreColor = genreColorMap[script.genre] || colors.primary;

  return (
    <>
      <Stack.Screen
        options={{
          title: script.title,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: "#fff",
        }}
      />
      <ScrollView style={s.container}>
        {/* Cover image */}
        {script.cover_image_url && (
          <Image source={{ uri: script.cover_image_url }} style={s.coverImage} />
        )}

        {/* Header */}
        <View style={s.header}>
          <View style={s.badgeRow}>
            <View style={[s.genreBadge, { backgroundColor: genreColor + "20" }]}>
              <Text style={[s.genreBadgeText, { color: genreColor }]}>
                {script.genre}
              </Text>
            </View>
            <View style={[s.statusBadge, { backgroundColor: isOpen ? colors.greenMuted : colors.elevated }]}>
              <View style={[s.statusDot, { backgroundColor: isOpen ? colors.green : colors.textMuted }]} />
              <Text style={[s.statusText, { color: isOpen ? colors.green : colors.textSecondary }]}>
                {SCRIPT_STATUS_LABELS[script.status]}
              </Text>
            </View>
          </View>

          <Text style={s.title}>{script.title}</Text>
          <Text style={s.logline}>{script.logline}</Text>

          {/* Stats + Read Script */}
          <View style={s.actionRow}>
            <View style={s.statChip}>
              <Feather name="users" size={14} color={colors.primary} />
              <Text style={s.statChipText}>{characters.length} roles</Text>
            </View>

            <TouchableOpacity style={s.readScriptBtn} onPress={openScript} activeOpacity={0.8}>
              <Feather name="file-text" size={16} color={colors.primary} />
              <Text style={s.readScriptText}>Read Full Script</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Casting Dashboard button for writers */}
        {isOwner && (script.status === "open" || script.status === "casting") && (
          <TouchableOpacity
            style={s.castingBtn}
            onPress={() => router.push(`/casting/${script.id}` as any)}
            activeOpacity={0.85}
          >
            <Feather name="layout" size={16} color="#fff" />
            <Text style={s.castingBtnText}>Open Casting Dashboard</Text>
          </TouchableOpacity>
        )}

        {/* Characters */}
        <View style={s.charsSection}>
          <View style={s.sectionHeader}>
            <View style={s.sectionAccent} />
            <Text style={s.sectionTitle}>Characters</Text>
          </View>

          {characters.map((char) => (
            <TouchableOpacity
              key={char.id}
              style={s.charCard}
              onPress={() => router.push(`/role/${char.id}` as any)}
              activeOpacity={0.8}
            >
              <View style={s.charRow}>
                <View style={s.charAvatar}>
                  <Text style={s.charInitial}>{char.name.charAt(0)}</Text>
                </View>
                <View style={s.charContent}>
                  <Text style={s.charName}>{char.name}</Text>
                  {char.description && (
                    <Text style={s.charDesc} numberOfLines={2}>
                      {char.description}
                    </Text>
                  )}
                  <View style={s.charMeta}>
                    <Text style={s.charMetaText}>{char.line_count} lines</Text>
                    <View style={s.metaDot} />
                    <Text style={s.charMetaText}>
                      {char.submission_count} submission
                      {char.submission_count !== 1 ? "s" : ""}
                    </Text>
                  </View>
                </View>
                <Feather name="chevron-right" size={18} color={colors.cardBorder} />
              </View>

              {isOpen && (
                <TouchableOpacity
                  style={s.auditionBtn}
                  onPress={() => {
                    if (!requireAuth("read for this role")) return;
                    router.push(`/recording/${char.id}` as any);
                  }}
                >
                  <Feather name="video" size={14} color={colors.primary} />
                  <Text style={s.auditionBtnText}>Read for this role</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  loadingContainer: {
    flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg,
  },
  container: { flex: 1, backgroundColor: colors.bg },
  coverImage: { width: "100%", height: 200 },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  badgeRow: { flexDirection: "row", alignItems: "center", marginBottom: spacing.md, gap: 8 },
  genreBadge: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full },
  genreBadgeText: { fontSize: 12, fontWeight: "700" },
  statusBadge: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, gap: 6,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 12, fontWeight: "600" },
  title: { color: colors.text, fontSize: 28, fontWeight: "800", lineHeight: 34 },
  logline: { color: colors.textSecondary, fontSize: 15, marginTop: spacing.md, lineHeight: 22 },
  actionRow: { flexDirection: "row", marginTop: spacing.xl, gap: spacing.md },
  statChip: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.card, paddingHorizontal: spacing.lg, paddingVertical: 10,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.cardBorder,
  },
  statChipText: { color: colors.text, fontSize: 14, fontWeight: "600", marginLeft: spacing.sm },
  readScriptBtn: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.primaryMuted, paddingHorizontal: spacing.lg, paddingVertical: 10,
    borderRadius: radius.md, gap: 8, borderWidth: 1, borderColor: "rgba(108,92,231,0.2)",
  },
  readScriptText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
  castingBtn: {
    marginHorizontal: spacing.xl, marginBottom: spacing.lg,
    backgroundColor: colors.primary, borderRadius: radius.xl,
    paddingVertical: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8,
  },
  castingBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  charsSection: { paddingHorizontal: spacing.xl, marginTop: spacing.sm, paddingBottom: 40 },
  sectionHeader: { flexDirection: "row", alignItems: "center", marginBottom: spacing.lg },
  sectionAccent: { width: 4, height: 20, backgroundColor: colors.primary, borderRadius: radius.full, marginRight: 10 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  charCard: {
    backgroundColor: colors.card, borderRadius: radius.xl, padding: spacing.xl,
    marginBottom: spacing.md, borderWidth: 1, borderColor: colors.cardBorder,
  },
  charRow: { flexDirection: "row", alignItems: "flex-start" },
  charAvatar: {
    width: 44, height: 44, borderRadius: radius.md,
    backgroundColor: colors.primaryMuted, alignItems: "center", justifyContent: "center",
    marginRight: spacing.md, marginTop: 2,
  },
  charInitial: { color: colors.primary, fontWeight: "700", fontSize: 16 },
  charContent: { flex: 1 },
  charName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  charDesc: { color: colors.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 18 },
  charMeta: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  charMetaText: { color: colors.textMuted, fontSize: 12 },
  metaDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.cardBorder, marginHorizontal: spacing.sm },
  auditionBtn: {
    marginTop: spacing.lg, backgroundColor: colors.primaryMuted,
    borderRadius: radius.md, paddingVertical: 10, alignItems: "center",
    borderWidth: 1, borderColor: "rgba(108,92,231,0.2)",
    flexDirection: "row", justifyContent: "center", gap: 8,
  },
  auditionBtnText: { color: colors.primary, fontWeight: "700", fontSize: 14 },
});
