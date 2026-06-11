import { useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Alert, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { ROLE_OPTIONS } from "@/lib/constants";
import { colors, radius, spacing } from "@/lib/theme";
import type { UserRole } from "@/lib/types";

export default function OnboardingScreen() {
  const { session, refreshProfile } = useAuth();
  const router = useRouter();
  const [selected, setSelected] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleContinue() {
    if (!selected || !session) return;
    setLoading(true);
    try {
      const { error } = await supabase.from("users").update({ role: selected }).eq("id", session.user.id);
      if (error) throw error;
      await refreshProfile();
      router.replace("/(tabs)" as any);
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={s.container}>
      <View style={s.header}>
        <View style={s.logoBox}>
          <Text style={s.logoLetter}>C</Text>
        </View>
        <Text style={s.title}>Welcome to Cast</Text>
        <Text style={s.subtitle}>How will you use the platform?</Text>
      </View>

      <View style={s.options}>
        {ROLE_OPTIONS.map((option) => {
          const active = selected === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[s.optionCard, active && s.optionActive]}
              onPress={() => setSelected(option.value)}
              activeOpacity={0.8}
            >
              <View style={[s.optionIcon, active && s.optionIconActive]}>
                <Feather name={option.icon as any} size={22} color={active ? colors.primary : colors.textSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.optionLabel, active && { color: colors.text }]}>{option.label}</Text>
                <Text style={s.optionDesc}>{option.description}</Text>
              </View>
              {active && (
                <View style={s.checkCircle}>
                  <Feather name="check" size={14} color="#fff" />
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      <TouchableOpacity
        style={[s.button, !selected && s.buttonDisabled]}
        onPress={handleContinue}
        disabled={!selected || loading}
        activeOpacity={0.85}
      >
        {loading ? <ActivityIndicator color="#fff" /> : (
          <Text style={[s.buttonText, !selected && { color: colors.textMuted }]}>Continue</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", paddingHorizontal: 28 },
  header: { alignItems: "center", marginBottom: 40 },
  logoBox: { width: 56, height: 56, borderRadius: radius.xl, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  logoLetter: { color: "#fff", fontSize: 24, fontWeight: "800" },
  title: { fontSize: 28, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 16, color: colors.textSecondary, marginTop: 6 },
  options: { gap: 12, marginBottom: 32 },
  optionCard: {
    flexDirection: "row", alignItems: "center", padding: 20,
    borderWidth: 2, borderColor: colors.cardBorder, borderRadius: radius.xl, backgroundColor: colors.card,
  },
  optionActive: { borderColor: colors.primary, backgroundColor: "rgba(108,92,231,0.08)" },
  optionIcon: { width: 48, height: 48, borderRadius: radius.lg, backgroundColor: colors.elevated, alignItems: "center", justifyContent: "center", marginRight: 16 },
  optionIconActive: { backgroundColor: colors.primaryMuted },
  optionLabel: { fontSize: 17, fontWeight: "700", color: "#c4c4d4" },
  optionDesc: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  checkCircle: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  button: { backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16, alignItems: "center" },
  buttonDisabled: { backgroundColor: colors.cardBorder },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
