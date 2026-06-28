import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Switch,
  Image,
  StyleSheet,
} from "react-native";
import { Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { HeaderBackButton } from "@/components/HeaderBackButton";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { uploadFile } from "@/lib/storage";
import { GENRES, ROLE_OPTIONS } from "@/lib/constants";
import type { UserRole } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

export default function SettingsScreen() {
  const { profile, session, refreshProfile, signOut } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [website, setWebsite] = useState(profile?.website ?? "");
  const links = (profile?.links as Record<string, string>) ?? {};
  const [x, setX] = useState(links.x ?? "");
  const [instagram, setInstagram] = useState(links.instagram ?? "");
  const [tiktok, setTiktok] = useState(links.tiktok ?? "");
  const [youtube, setYoutube] = useState(links.youtube ?? "");
  const [imdb, setImdb] = useState(links.imdb ?? "");
  const [demoReelUrl, setDemoReelUrl] = useState((profile as any)?.demo_reel_url ?? "");
  const [genres, setGenres] = useState<string[]>(profile?.genre_specialties ?? []);
  const [roles, setRoles] = useState<UserRole[]>(
    profile?.roles ?? (profile?.role ? [profile.role] : [])
  );
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Notification preferences
  const defaultPrefs = {
    new_scripts: true,
    writers_choice: true,
    new_submissions: true,
    assembly_ready: true,
    audience_votes: true,
    comments: true,
  };
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>(
    (profile as any)?.notification_preferences ?? defaultPrefs
  );

  async function pickAvatar() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Please allow photo library access.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets.length > 0) {
      setAvatarUri(result.assets[0].uri);
    }
  }

  function toggleGenre(g: string) {
    setGenres((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]
    );
  }

  function toggleRole(r: UserRole) {
    setRoles((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
    );
  }

  function toggleNotif(key: string) {
    setNotifPrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleSave() {
    if (!session) return;
    if (roles.length === 0) {
      Alert.alert("Pick a role", "Select at least one role.");
      return;
    }
    setSaving(true);
    try {
      let avatarUrl = profile?.avatar_url;

      // Keep the active role valid if the user removed it from their set.
      const activeRole =
        profile?.role && roles.includes(profile.role) ? profile.role : roles[0];

      // Upload new avatar if selected
      if (avatarUri) {
        const ext = avatarUri.split(".").pop() ?? "jpg";
        // Timestamped so a rejected upload never clobbers the existing avatar.
        const path = `${session.user.id}/avatar-${Date.now()}.${ext}`;
        await uploadFile("avatars", path, avatarUri, `image/${ext}`);
        // Screen the photo before it becomes the avatar.
        const { data: mod } = await supabase.functions.invoke("moderate-avatar", {
          body: { path },
        });
        if ((mod as any)?.status !== "approved") {
          Alert.alert(
            (mod as any)?.status === "rejected" ? "Photo flagged" : "Couldn't check photo",
            (mod as any)?.status === "rejected"
              ? "That photo was flagged by our automated check. Please choose another and save again."
              : "We couldn't check that photo. Please try another."
          );
          return;
        }
        const { data } = supabase.storage.from("avatars").getPublicUrl(path);
        avatarUrl = data.publicUrl;
      }

      const { error } = await supabase
        .from("users")
        .update({
          display_name: displayName.trim(),
          bio: bio.trim() || null,
          username:
            username
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, "-")
              .replace(/^-+|-+$/g, "") ||
            profile?.username ||
            undefined,
          website: website.trim() || null,
          links: {
            x: x.trim(),
            instagram: instagram.trim(),
            tiktok: tiktok.trim(),
            youtube: youtube.trim(),
            imdb: imdb.trim(),
          },
          avatar_url: avatarUrl,
          demo_reel_url: demoReelUrl.trim() || null,
          genre_specialties: genres,
          roles,
          role: activeRole,
          notification_preferences: notifPrefs,
        })
        .eq("id", session.user.id);

      if (error) throw error;
      await refreshProfile();
      Alert.alert("Saved", "Your profile has been updated.");
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteAccount() {
    Alert.alert(
      "Delete account?",
      "This permanently deletes your account, your scripts, your reads, and all your data. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              const { data, error } = await supabase.functions.invoke("delete-account", { body: {} });
              if (error || (data as any)?.error) {
                throw new Error((error as any)?.message ?? (data as any)?.error);
              }
              await signOut();
            } catch (e: any) {
              Alert.alert("Couldn't delete account", e?.message ?? String(e));
              setDeleting(false);
            }
          },
        },
      ]
    );
  }

  const notifLabels: Record<string, string> = {
    new_scripts: "New scripts uploaded",
    writers_choice: "Writer's Choice selections",
    new_submissions: "New audition submissions",
    assembly_ready: "Table read assembled",
    audience_votes: "Audience vote milestones",
    comments: "New comments",
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Settings",
          headerShown: true,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerLeft: ({ tintColor }) => <HeaderBackButton tintColor={tintColor} />,
        }}
      />
      <ScrollView style={s.container} contentContainerStyle={{ padding: spacing.xl, paddingBottom: 60 }}>
        {/* Avatar */}
        <View style={s.avatarSection}>
          <TouchableOpacity onPress={pickAvatar} activeOpacity={0.8}>
            {avatarUri || profile?.avatar_url ? (
              <Image
                source={{ uri: avatarUri || profile?.avatar_url! }}
                style={s.avatar}
              />
            ) : (
              <View style={s.avatarPlaceholder}>
                <Feather name="camera" size={24} color={colors.textMuted} />
              </View>
            )}
            <View style={s.avatarEdit}>
              <Feather name="edit-2" size={12} color="#fff" />
            </View>
          </TouchableOpacity>
          <Text style={s.avatarHint}>Tap to change photo</Text>
        </View>

        {/* Display Name */}
        <Text style={s.label}>DISPLAY NAME</Text>
        <TextInput
          style={s.input}
          value={displayName}
          onChangeText={setDisplayName}
          placeholderTextColor={colors.textMuted}
        />

        {/* Bio */}
        <Text style={s.label}>BIO</Text>
        <TextInput
          style={[s.input, { minHeight: 80, textAlignVertical: "top" }]}
          value={bio}
          onChangeText={setBio}
          multiline
          numberOfLines={3}
          placeholderTextColor={colors.textMuted}
          placeholder="Tell people about yourself..."
        />

        {/* Username (profile URL) */}
        <Text style={s.label}>USERNAME · prelogue.studio/u/…</Text>
        <TextInput
          style={s.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={colors.textMuted}
          placeholder="your-name"
        />

        {/* Website */}
        <Text style={s.label}>WEBSITE</Text>
        <TextInput
          style={s.input}
          value={website}
          onChangeText={setWebsite}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholderTextColor={colors.textMuted}
          placeholder="https://"
        />

        {/* Social links */}
        <Text style={s.label}>SOCIAL LINKS</Text>
        <TextInput
          style={s.input}
          value={x}
          onChangeText={setX}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={colors.textMuted}
          placeholder="X (Twitter) URL"
        />
        <TextInput
          style={s.input}
          value={instagram}
          onChangeText={setInstagram}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={colors.textMuted}
          placeholder="Instagram URL"
        />
        <TextInput
          style={s.input}
          value={tiktok}
          onChangeText={setTiktok}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={colors.textMuted}
          placeholder="TikTok URL"
        />
        <TextInput
          style={s.input}
          value={youtube}
          onChangeText={setYoutube}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={colors.textMuted}
          placeholder="YouTube URL"
        />
        <TextInput
          style={s.input}
          value={imdb}
          onChangeText={setImdb}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={colors.textMuted}
          placeholder="IMDb URL"
        />

        {/* Roles */}
        <Text style={s.label}>YOUR ROLES</Text>
        <View style={s.genreGrid}>
          {ROLE_OPTIONS.map((opt) => {
            const active = roles.includes(opt.value);
            return (
              <TouchableOpacity
                key={opt.value}
                style={[s.genreChip, active && s.genreActive]}
                onPress={() => toggleRole(opt.value)}
              >
                <Text style={active ? s.genreTextActive : s.genreTextInactive}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Demo Reel (actors) */}
        {profile?.role === "actor" && (
          <>
            <Text style={s.label}>DEMO REEL URL</Text>
            <TextInput
              style={s.input}
              value={demoReelUrl}
              onChangeText={setDemoReelUrl}
              placeholderTextColor={colors.textMuted}
              placeholder="https://youtube.com/..."
              autoCapitalize="none"
              keyboardType="url"
            />
          </>
        )}

        {/* Genre Specialties (actors) */}
        {profile?.role === "actor" && (
          <>
            <Text style={s.label}>GENRE SPECIALTIES</Text>
            <View style={s.genreGrid}>
              {GENRES.map((g) => {
                const active = genres.includes(g);
                return (
                  <TouchableOpacity
                    key={g}
                    style={[s.genreChip, active && s.genreActive]}
                    onPress={() => toggleGenre(g)}
                  >
                    <Text style={active ? s.genreTextActive : s.genreTextInactive}>
                      {g}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}

        {/* Notification Preferences */}
        <Text style={s.sectionLabel}>NOTIFICATIONS</Text>
        <View style={s.notifCard}>
          {Object.entries(notifLabels).map(([key, label], idx) => (
            <View
              key={key}
              style={[
                s.notifRow,
                idx < Object.keys(notifLabels).length - 1 && s.notifRowBorder,
              ]}
            >
              <Text style={s.notifLabel}>{label}</Text>
              <Switch
                value={notifPrefs[key] ?? true}
                onValueChange={() => toggleNotif(key)}
                trackColor={{ false: colors.cardBorder, true: colors.primary }}
                thumbColor="#fff"
              />
            </View>
          ))}
        </View>

        {/* Save */}
        <TouchableOpacity
          style={s.saveBtn}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.saveBtnText}>Save Changes</Text>
          )}
        </TouchableOpacity>

        {/* Account info */}
        <View style={s.infoCard}>
          <Text style={s.infoLine}>
            Role: <Text style={s.infoValue}>{profile?.role}</Text>
          </Text>
          <Text style={[s.infoLine, { marginTop: 4 }]}>
            Member since:{" "}
            <Text style={s.infoValue}>
              {profile ? new Date(profile.created_at).toLocaleDateString() : ""}
            </Text>
          </Text>
        </View>

        {/* Sign out */}
        <TouchableOpacity style={s.signOutBtn} onPress={signOut} activeOpacity={0.7}>
          <Text style={s.signOutText}>Sign Out</Text>
        </TouchableOpacity>

        {/* Delete account (required by the App Store) */}
        <TouchableOpacity
          style={s.deleteBtn}
          onPress={handleDeleteAccount}
          disabled={deleting}
          activeOpacity={0.7}
        >
          {deleting ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : (
            <Text style={s.deleteText}>Delete account</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  avatarSection: { alignItems: "center", marginBottom: spacing.xxl },
  avatar: { width: 88, height: 88, borderRadius: 44 },
  avatarPlaceholder: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
    alignItems: "center", justifyContent: "center",
  },
  avatarEdit: {
    position: "absolute", bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.primary, alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: colors.bg,
  },
  avatarHint: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
  label: {
    color: colors.textSecondary, fontSize: 11, fontWeight: "700",
    letterSpacing: 1.5, marginBottom: 8, marginLeft: 4, marginTop: spacing.lg,
  },
  sectionLabel: {
    color: colors.textSecondary, fontSize: 11, fontWeight: "700",
    letterSpacing: 1.5, marginBottom: spacing.md, marginLeft: 4, marginTop: spacing.xxl,
  },
  input: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
    borderRadius: radius.xl, paddingHorizontal: 20, paddingVertical: 16,
    color: colors.text, fontSize: 16,
  },
  genreGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  genreChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
  },
  genreActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  genreTextActive: { color: "#fff", fontWeight: "600", fontSize: 13 },
  genreTextInactive: { color: colors.textSecondary, fontSize: 13 },
  notifCard: {
    backgroundColor: colors.card, borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.cardBorder, overflow: "hidden",
  },
  notifRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 14,
  },
  notifRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  notifLabel: { color: colors.text, fontSize: 14, flex: 1 },
  saveBtn: {
    backgroundColor: colors.primary, borderRadius: radius.xl,
    paddingVertical: 16, alignItems: "center", marginTop: spacing.xxl,
  },
  saveBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  infoCard: {
    backgroundColor: colors.card, borderRadius: radius.xl, padding: spacing.xl,
    borderWidth: 1, borderColor: colors.cardBorder, marginTop: spacing.xxl,
  },
  infoLine: { color: colors.textMuted, fontSize: 14 },
  infoValue: { color: colors.text, textTransform: "capitalize" },
  signOutBtn: {
    backgroundColor: colors.redMuted, borderWidth: 1, borderColor: "rgba(168,47,28,0.25)",
    borderRadius: radius.xl, paddingVertical: 14, alignItems: "center", marginTop: spacing.lg,
  },
  signOutText: { color: colors.red, fontWeight: "700" },
  deleteBtn: { paddingVertical: 14, alignItems: "center", marginTop: spacing.sm, marginBottom: spacing.xl },
  deleteText: { color: colors.textMuted, fontSize: 13, fontWeight: "600", textDecorationLine: "underline" },
});
