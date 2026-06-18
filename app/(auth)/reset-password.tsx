import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { colors, radius, spacing } from "@/lib/theme";

/**
 * Lands here from the password-recovery email deep link
 * (cast://reset-password?code=...). Establishes the recovery session from
 * whatever the link carries (PKCE code, token_hash, or tokens), then lets the
 * user set a new password.
 */
export default function ResetPasswordScreen() {
  const params = useLocalSearchParams<{
    code?: string;
    token_hash?: string;
    type?: string;
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  }>();
  const router = useRouter();
  const [status, setStatus] = useState<"verifying" | "ready" | "error">("verifying");
  const [errorMsg, setErrorMsg] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (params.error) {
          throw new Error(String(params.error_description || params.error));
        }
        if (params.code) {
          const { error } = await supabase.auth.exchangeCodeForSession(String(params.code));
          if (error) throw error;
        } else if (params.token_hash) {
          const { error } = await supabase.auth.verifyOtp({
            type: "recovery",
            token_hash: String(params.token_hash),
          });
          if (error) throw error;
        } else if (params.access_token && params.refresh_token) {
          const { error } = await supabase.auth.setSession({
            access_token: String(params.access_token),
            refresh_token: String(params.refresh_token),
          });
          if (error) throw error;
        } else {
          throw new Error("This reset link is missing its token. Request a new one.");
        }
        if (active) setStatus("ready");
      } catch (e: any) {
        if (active) {
          setErrorMsg(e?.message ?? "This reset link is invalid or has expired.");
          setStatus("error");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [params.code, params.token_hash, params.access_token]);

  async function handleUpdate() {
    if (password.length < 6) {
      Alert.alert("Error", "Password must be at least 6 characters");
      return;
    }
    if (password !== confirm) {
      Alert.alert("Error", "Passwords don't match");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      Alert.alert("Password updated", "You're all set.", [
        { text: "Continue", onPress: () => router.replace("/(tabs)" as any) },
      ]);
    } catch (e: any) {
      Alert.alert("Couldn't update password", e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  if (status === "verifying") {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={s.sub}>Verifying your reset link…</Text>
      </View>
    );
  }

  if (status === "error") {
    return (
      <View style={s.center}>
        <Feather name="alert-triangle" size={36} color={colors.red} />
        <Text style={s.title}>Reset link problem</Text>
        <Text style={s.sub}>{errorMsg}</Text>
        <TouchableOpacity
          style={s.button}
          onPress={() => router.replace("/(auth)/forgot-password" as any)}
          activeOpacity={0.85}
        >
          <Text style={s.buttonText}>Request a new link</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={s.container}>
      <View style={s.inner}>
        <Text style={s.title}>Set a new password</Text>
        <Text style={s.sub}>Choose a new password for your account.</Text>

        <Text style={s.label}>NEW PASSWORD</Text>
        <TextInput
          style={s.input}
          placeholder="At least 6 characters"
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoFocus
        />

        <Text style={[s.label, { marginTop: spacing.lg }]}>CONFIRM PASSWORD</Text>
        <TextInput
          style={s.input}
          placeholder="Re-enter password"
          placeholderTextColor={colors.textMuted}
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          onSubmitEditing={handleUpdate}
          returnKeyType="done"
        />

        <TouchableOpacity
          style={[s.button, saving && { opacity: 0.7 }]}
          onPress={handleUpdate}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>Update Password</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, gap: 12 },
  inner: { flex: 1, justifyContent: "center", paddingHorizontal: 28 },
  title: { fontSize: 28, fontWeight: "800", color: colors.text, textAlign: "center" },
  sub: { fontSize: 15, color: colors.textSecondary, marginTop: 8, textAlign: "center", lineHeight: 22 },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1.5, marginBottom: 8, marginLeft: 4, marginTop: spacing.xl },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.xl, paddingHorizontal: 20, paddingVertical: 16, color: colors.text, fontSize: 16 },
  button: { backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16, alignItems: "center", marginTop: 28 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
