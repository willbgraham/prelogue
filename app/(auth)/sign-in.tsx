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
import { useAuth } from "@/lib/auth";
import { colors, radius, spacing } from "@/lib/theme";

export default function SignInScreen() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignIn() {
    if (!email || !password) {
      Alert.alert("Error", "Please fill in all fields");
      return;
    }
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      router.replace("/(tabs)" as any);
    } catch (error: any) {
      Alert.alert("Sign In Failed", error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={s.container}
    >
      <View style={s.inner}>
        {/* Logo */}
        <View style={s.logoSection}>
          <View style={s.logoBox}>
            <Text style={s.logoLetter}>P</Text>
          </View>
          <Text style={s.appName}>Prelogue</Text>
          <Text style={s.tagline}>Table reads, reimagined</Text>
        </View>

        {/* Form */}
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
        />

        <Text style={[s.label, { marginTop: spacing.lg }]}>PASSWORD</Text>
        <TextInput
          style={s.input}
          placeholder="Your password"
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
        />

        <Link href="/(auth)/forgot-password" asChild>
          <TouchableOpacity style={s.forgotRow} activeOpacity={0.7}>
            <Text style={s.forgotText}>Forgot password?</Text>
          </TouchableOpacity>
        </Link>

        <TouchableOpacity
          style={[s.button, loading && { opacity: 0.7 }]}
          onPress={handleSignIn}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.buttonText}>Sign In</Text>
          )}
        </TouchableOpacity>

        <View style={s.footer}>
          <Text style={s.footerText}>Don't have an account? </Text>
          <Link href="/(auth)/sign-up" asChild>
            <TouchableOpacity>
              <Text style={s.footerLink}>Sign Up</Text>
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
  logoSection: { alignItems: "center", marginBottom: 48 },
  logoBox: {
    width: 72, height: 72, borderRadius: radius.xxl,
    backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginBottom: 20,
  },
  logoLetter: { color: "#fff", fontSize: 32, fontWeight: "800" },
  appName: { fontSize: 44, fontWeight: "800", color: colors.text, letterSpacing: -1 },
  tagline: { fontSize: 16, color: colors.textSecondary, marginTop: 6 },
  label: {
    color: colors.textSecondary, fontSize: 11, fontWeight: "700",
    letterSpacing: 1.5, marginBottom: 8, marginLeft: 4,
  },
  input: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
    borderRadius: radius.xl, paddingHorizontal: 20, paddingVertical: 16,
    color: colors.text, fontSize: 16,
  },
  forgotRow: { alignSelf: "flex-end", marginTop: 14, paddingVertical: 2 },
  forgotText: { color: colors.primary, fontSize: 14, fontWeight: "600" },
  button: {
    backgroundColor: colors.primary, borderRadius: radius.xl,
    paddingVertical: 16, alignItems: "center", marginTop: 20,
  },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16, letterSpacing: 0.3 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 24 },
  footerText: { color: colors.textSecondary, fontSize: 15 },
  footerLink: { color: colors.primary, fontWeight: "700", fontSize: 15 },
});
