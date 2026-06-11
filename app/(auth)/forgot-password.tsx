import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from "react-native";
import { Link, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import { colors, radius, spacing } from "@/lib/theme";

export default function ForgotPasswordScreen() {
  const { resetPassword } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleReset() {
    const trimmed = email.trim();
    if (!trimmed) {
      Alert.alert("Error", "Please enter your email");
      return;
    }
    setLoading(true);
    try {
      await resetPassword(trimmed);
      setSent(true);
    } catch (error: any) {
      Alert.alert("Couldn't send reset link", error.message);
    } finally {
      setLoading(false);
    }
  }

  // Confirmation state
  if (sent) {
    return (
      <View style={s.container}>
        <View style={s.inner}>
          <View style={s.successIconBox}>
            <Feather name="mail" size={32} color={colors.primary} />
          </View>
          <Text style={s.title}>Check your email</Text>
          <Text style={s.subtitle}>
            If an account exists for {email.trim()}, we've sent a link to reset
            your password.
          </Text>

          <TouchableOpacity
            style={s.button}
            onPress={() => router.replace("/(auth)/sign-in" as any)}
            activeOpacity={0.85}
          >
            <Text style={s.buttonText}>Back to Sign In</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={s.footer}
            onPress={() => setSent(false)}
            activeOpacity={0.7}
          >
            <Text style={s.footerText}>Didn't get it? </Text>
            <Text style={s.footerLink}>Try again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Request form
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={s.container}
    >
      <View style={s.inner}>
        <View style={s.header}>
          <Text style={s.title}>Forgot password?</Text>
          <Text style={s.subtitle}>
            Enter your email and we'll send you a link to reset it.
          </Text>
        </View>

        <Text style={s.label}>EMAIL</Text>
        <TextInput
          style={s.input}
          placeholder="you@example.com"
          placeholderTextColor={colors.textMuted}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          autoFocus
          onSubmitEditing={handleReset}
          returnKeyType="send"
        />

        <TouchableOpacity
          style={[s.button, loading && { opacity: 0.7 }]}
          onPress={handleReset}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.buttonText}>Send Reset Link</Text>
          )}
        </TouchableOpacity>

        <View style={s.footer}>
          <Text style={s.footerText}>Remembered it? </Text>
          <Link href="/(auth)/sign-in" asChild>
            <TouchableOpacity>
              <Text style={s.footerLink}>Sign In</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  inner: { flex: 1, justifyContent: "center", paddingHorizontal: 28 },
  header: { alignItems: "center", marginBottom: 40 },
  successIconBox: {
    width: 72,
    height: 72,
    borderRadius: radius.xxl,
    backgroundColor: colors.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 20,
  },
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: colors.textSecondary,
    marginTop: 8,
    textAlign: "center",
    lineHeight: 22,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.5,
    marginBottom: 8,
    marginLeft: 4,
  },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.xl,
    paddingHorizontal: 20,
    paddingVertical: 16,
    color: colors.text,
    fontSize: 16,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 32,
  },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16, letterSpacing: 0.3 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 24 },
  footerText: { color: colors.textSecondary, fontSize: 15 },
  footerLink: { color: colors.primary, fontWeight: "700", fontSize: 15 },
});
