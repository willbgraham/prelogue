import { useState } from "react";
import { View, Text, TouchableOpacity, Image, Alert, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import type { UserRole } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

const roleIconFor = (r?: string | null) =>
  r === "writer" ? "edit-3" : r === "actor" ? "video" : "eye";

export default function ProfileScreen() {
  const { profile, session, refreshProfile, signOut } = useAuth();
  const router = useRouter();
  const [switching, setSwitching] = useState(false);

  async function switchRole(r: UserRole) {
    if (!session || r === profile?.role) return;
    setSwitching(true);
    try {
      const { error } = await supabase.from("users").update({ role: r }).eq("id", session.user.id);
      if (error) throw error;
      await refreshProfile();
    } catch (e: any) {
      Alert.alert("Couldn't switch role", e.message);
    } finally {
      setSwitching(false);
    }
  }

  if (!profile) {
    return (
      <View style={s.container}>
        <View style={s.guestContainer}>
          <View style={s.guestIcon}>
            <Feather name="user" size={40} color={colors.textMuted} />
          </View>
          <Text style={s.guestTitle}>Your Profile</Text>
          <Text style={s.guestSub}>
            Sign in to track your auditions, build your portfolio, and connect with writers.
          </Text>
          <TouchableOpacity
            style={s.guestBtn}
            onPress={() => router.push("/(auth)/sign-in" as any)}
            activeOpacity={0.85}
          >
            <Text style={s.guestBtnText}>Sign In</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.guestBtnOutline}
            onPress={() => router.push("/(auth)/sign-up" as any)}
            activeOpacity={0.85}
          >
            <Text style={s.guestBtnOutlineText}>Create Account</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const myRoles: UserRole[] = profile.roles ?? (profile.role ? [profile.role] : []);

  return (
    <View style={s.container}>
      {/* Header card */}
      <View style={s.headerCard}>
        {/* Top accent */}
        <View style={s.accentBar} />
        <View style={s.headerContent}>
          {profile.avatar_url ? (
            <Image
              source={{ uri: profile.avatar_url }}
              style={s.avatar}
            />
          ) : (
            <View style={s.avatarPlaceholder}>
              <Feather name="user" size={28} color={colors.primary} />
            </View>
          )}
          <Text style={s.displayName}>
            {profile.display_name}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6 }}>
            {myRoles.map((r) => (
              <View key={r} style={s.roleBadge}>
                <Feather name={roleIconFor(r) as any} size={12} color={colors.textSecondary} />
                <Text style={s.roleText}>{r.charAt(0).toUpperCase() + r.slice(1)}</Text>
              </View>
            ))}
          </View>
          {profile.bio && (
            <Text style={s.bio}>
              {profile.bio}
            </Text>
          )}
        </View>
      </View>

      {/* Acting-as role switcher (only when the user has more than one role) */}
      {myRoles.length > 1 && (
        <View style={s.switcherSection}>
          <Text style={s.switcherLabel}>ACTING AS</Text>
          <View style={s.switcher}>
            {myRoles.map((r) => {
              const isActive = profile.role === r;
              return (
                <TouchableOpacity
                  key={r}
                  style={[s.switcherBtn, isActive && s.switcherBtnActive]}
                  onPress={() => switchRole(r)}
                  disabled={switching}
                  activeOpacity={0.8}
                >
                  <Feather
                    name={roleIconFor(r) as any}
                    size={14}
                    color={isActive ? "#fff" : colors.textSecondary}
                  />
                  <Text style={[s.switcherText, isActive && s.switcherTextActive]}>{r}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* Stats row for actors */}
      {profile.role === "actor" && (
        <View style={s.statsRow}>
          <View style={s.statCard}>
            <Feather name="award" size={20} color={colors.yellow} />
            <Text style={s.statValue}>
              {profile.writers_choice_count}
            </Text>
            <Text style={s.statLabel}>Writer's Choice</Text>
          </View>
          <View style={s.statCard}>
            <Feather name="heart" size={20} color={colors.red} />
            <Text style={s.statValue}>
              {profile.audience_favorite_count}
            </Text>
            <Text style={s.statLabel}>Audience Fav</Text>
          </View>
        </View>
      )}

      {/* Menu */}
      <View style={s.menuContainer}>
        {profile.username ? (
          <TouchableOpacity
            style={s.menuItem}
            onPress={() => router.push(`/u/${profile.username}` as any)}
            activeOpacity={0.7}
          >
            <View style={s.menuIconBox}>
              <Feather name="user" size={18} color={colors.textSecondary} />
            </View>
            <Text style={s.menuText}>View public profile</Text>
            <Feather name="chevron-right" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={s.menuItem}
          onPress={() => router.push("/settings" as any)}
          activeOpacity={0.7}
        >
          <View style={s.menuIconBox}>
            <Feather name="settings" size={18} color={colors.textSecondary} />
          </View>
          <Text style={s.menuText}>Settings</Text>
          <Feather name="chevron-right" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          style={s.menuItemSignOut}
          onPress={signOut}
          activeOpacity={0.7}
        >
          <View style={s.signOutIconBox}>
            <Feather name="log-out" size={18} color={colors.red} />
          </View>
          <Text style={s.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  headerCard: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    overflow: "hidden",
  },
  accentBar: {
    height: 80,
    backgroundColor: "rgba(188, 64, 38, 0.2)",
  },
  headerContent: {
    alignItems: "center",
    marginTop: -40,
    paddingBottom: 24,
    paddingHorizontal: spacing.xl,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: radius.lg,
    borderWidth: 4,
    borderColor: colors.card,
  },
  avatarPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: radius.lg,
    backgroundColor: "rgba(188, 64, 38, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: colors.card,
  },
  displayName: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "800",
    marginTop: spacing.md,
  },
  roleBadge: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
    backgroundColor: colors.elevated,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  roleText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
    textTransform: "capitalize",
    marginLeft: 6,
  },
  bio: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    lineHeight: 20,
  },
  switcherSection: { marginHorizontal: spacing.xl, marginTop: spacing.lg },
  switcherLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1.2, marginBottom: 8, marginLeft: 4 },
  switcher: { flexDirection: "row", gap: spacing.sm },
  switcherBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: 10, borderRadius: radius.md,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
  },
  switcherBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  switcherText: { color: colors.textSecondary, fontSize: 13, fontWeight: "600", textTransform: "capitalize" },
  switcherTextActive: { color: "#fff" },
  statsRow: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.md,
    flexDirection: "row",
    gap: spacing.md,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  statValue: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
    marginTop: 4,
  },
  statLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  menuContainer: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.xl,
  },
  menuItem: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  menuIconBox: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.elevated,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  menuText: {
    color: colors.text,
    fontWeight: "500",
    flex: 1,
  },
  menuItemSignOut: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  signOutIconBox: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: "rgba(255, 118, 117, 0.1)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  signOutText: {
    color: colors.red,
    fontWeight: "500",
  },
  guestContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  guestIcon: {
    width: 88,
    height: 88,
    borderRadius: radius.xxl,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xxl,
  },
  guestTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.text,
    marginBottom: spacing.sm,
  },
  guestSub: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: spacing.xxxl,
  },
  guestBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
    paddingVertical: 16,
    paddingHorizontal: 48,
    alignItems: "center",
    width: "100%",
    marginBottom: spacing.md,
  },
  guestBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  guestBtnOutline: {
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    borderRadius: radius.xl,
    paddingVertical: 16,
    paddingHorizontal: 48,
    alignItems: "center",
    width: "100%",
  },
  guestBtnOutlineText: {
    color: colors.textSecondary,
    fontWeight: "700",
    fontSize: 16,
  },
});
