import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Image,
  Linking,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { colors, radius, spacing, genreColors } from "@/lib/theme";

// Feather has no TikTok glyph — "music" stands in.
const SOCIAL: { key: string; icon: string }[] = [
  { key: "x", icon: "twitter" },
  { key: "instagram", icon: "instagram" },
  { key: "tiktok", icon: "music" },
  { key: "youtube", icon: "youtube" },
];

export default function PublicProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const router = useRouter();
  const [profile, setProfile] = useState<any>(null);
  const [scripts, setScripts] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: p } = await supabase.from("users").select("*").eq("username", username).single();
      if (p) {
        setProfile(p);
        const [{ data: sc }, { data: sub }] = await Promise.all([
          supabase
            .from("scripts")
            .select("id, slug, title, genre, logline, visibility")
            .eq("writer_id", p.id)
            .order("created_at", { ascending: false }),
          supabase
            .from("submissions")
            .select("character:characters(name), script:scripts(id, title)")
            .eq("actor_id", p.id),
        ]);
        setScripts((sc ?? []).filter((x: any) => (x.visibility ?? "public") !== "private"));
        const seen = new Set<string>();
        setRoles(
          (sub ?? [])
            .filter((r: any) => r.script && r.character)
            .filter((r: any) => {
              const k = `${r.script.id}:${r.character.name}`;
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            })
        );
      }
      setLoading(false);
    })();
  }, [username]);

  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (!profile) {
    return (
      <View style={s.center}>
        <Text style={{ color: colors.textMuted }}>Profile not found.</Text>
      </View>
    );
  }

  const links: Record<string, string> = profile.links ?? {};

  return (
    <>
      <Stack.Screen
        options={{ title: "", headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }}
      />
      <ScrollView style={s.container} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={s.header}>
          {profile.avatar_url ? (
            <Image source={{ uri: profile.avatar_url }} style={s.avatar} />
          ) : (
            <View style={s.avatarPh}>
              <Text style={s.avatarInitial}>
                {(profile.display_name || "?").charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          <Text style={s.name}>{profile.display_name}</Text>
          <Text style={s.handle}>@{profile.username}</Text>
          {profile.bio ? <Text style={s.bio}>{profile.bio}</Text> : null}

          <View style={s.socialRow}>
            {profile.website ? (
              <TouchableOpacity onPress={() => Linking.openURL(profile.website)} style={s.socialBtn}>
                <Feather name="globe" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            ) : null}
            {SOCIAL.map((so) =>
              links[so.key] ? (
                <TouchableOpacity
                  key={so.key}
                  onPress={() => Linking.openURL(links[so.key])}
                  style={s.socialBtn}
                >
                  <Feather name={so.icon as any} size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              ) : null
            )}
            {links.imdb ? (
              <TouchableOpacity onPress={() => Linking.openURL(links.imdb)} style={s.imdbBtn}>
                <Text style={s.imdbText}>IMDb</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {scripts.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Scripts</Text>
            {scripts.map((sc) => (
              <TouchableOpacity
                key={sc.id}
                style={s.card}
                onPress={() => router.push(`/script/${sc.id}` as any)}
                activeOpacity={0.85}
              >
                <Text style={[s.cardGenre, { color: genreColors[sc.genre] || colors.primary }]}>
                  {sc.genre}
                </Text>
                <Text style={s.cardTitle}>{sc.title}</Text>
                {sc.logline ? (
                  <Text style={s.cardLogline} numberOfLines={2}>
                    {sc.logline}
                  </Text>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {roles.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Roles read</Text>
            {roles.map((r, i) => (
              <TouchableOpacity
                key={i}
                style={s.roleRow}
                onPress={() => router.push(`/script/${r.script.id}` as any)}
                activeOpacity={0.7}
              >
                <Text style={s.roleName}>{r.character.name}</Text>
                <Text style={s.roleScript}>{r.script.title} ›</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {scripts.length === 0 && roles.length === 0 && (
          <Text style={s.empty}>No public scripts or roles yet.</Text>
        )}
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: { alignItems: "center", paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.lg },
  avatar: { width: 88, height: 88, borderRadius: 44 },
  avatarPh: {
    width: 88, height: 88, borderRadius: 44, backgroundColor: colors.primaryMuted,
    alignItems: "center", justifyContent: "center",
  },
  avatarInitial: { color: colors.primary, fontSize: 32, fontFamily: "RobotoSlab_700Bold" },
  name: { color: colors.text, fontSize: 24, fontFamily: "RobotoSlab_700Bold", marginTop: spacing.md },
  handle: { color: colors.textMuted, fontSize: 14, marginTop: 2 },
  bio: { color: colors.textSecondary, fontSize: 14, textAlign: "center", marginTop: spacing.md, lineHeight: 20 },
  socialRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  socialBtn: {
    width: 40, height: 40, borderRadius: radius.full, borderWidth: 1, borderColor: colors.cardBorder,
    alignItems: "center", justifyContent: "center", backgroundColor: colors.card,
  },
  imdbBtn: {
    height: 40, borderRadius: radius.full, paddingHorizontal: 12,
    alignItems: "center", justifyContent: "center", backgroundColor: "#f5c518",
  },
  imdbText: { color: "#000", fontSize: 13, fontWeight: "800" },
  section: { paddingHorizontal: spacing.xl, marginTop: spacing.lg },
  sectionTitle: { color: colors.text, fontSize: 18, fontFamily: "RobotoSlab_700Bold", marginBottom: spacing.md },
  card: {
    backgroundColor: colors.card, borderRadius: radius.xl, padding: spacing.lg,
    borderWidth: 1, borderColor: colors.cardBorder, marginBottom: spacing.md,
  },
  cardGenre: { fontSize: 12, fontWeight: "700" },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: "700", marginTop: 4 },
  cardLogline: { color: colors.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 18 },
  roleRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
  },
  roleName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  roleScript: { color: colors.textSecondary, fontSize: 13 },
  empty: { color: colors.textMuted, fontSize: 14, textAlign: "center", marginTop: spacing.xxl },
});
