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
  ScrollView,
  StyleSheet,
} from "react-native";
import { Link, useRouter } from "expo-router";
import { useAuth } from "@/lib/auth";
import { colors, radius, spacing } from "@/lib/theme";

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignUp() {
    if (!displayName || !email || !password) {
      Alert.alert("Error", "Please fill in all fields");
      return;
    }
    if (password.length < 6) {
      Alert.alert("Error", "Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    try {
      await signUp(email.trim(), password, displayName.trim());
      // Auto-confirm is enabled — user is signed in automatically
      // Send to onboarding to pick a role
      router.replace("/(auth)/onboarding" as any);
    } catch (error: any) {
      Alert.alert("Sign Up Failed", error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={s.container}>
      <ScrollView contentContainerStyle={s.inner} keyboardShouldPersistTaps="handled">
        <View style={s.header}>
          <Text style={s.title}>Create Account</Text>
          <Text style={s.subtitle}>Join the Cast community</Text>
        </View>

        <Text style={s.label}>DISPLAY NAME</Text>
        <TextInput style={s.input} placeholder="Your name" placeholderTextColor={colors.textMuted} value={displayName} onChangeText={setDisplayName} />

        <Text style={[s.label, { marginTop: spacing.lg }]}>EMAIL</Text>
        <TextInput style={s.input} placeholder="you@example.com" placeholderTextColor={colors.textMuted} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />

        <Text style={[s.label, { marginTop: spacing.lg }]}>PASSWORD</Text>
        <TextInput style={s.input} placeholder="At least 6 characters" placeholderTextColor={colors.textMuted} value={password} onChangeText={setPassword} secureTextEntry />

        <TouchableOpacity style={[s.button, loading && { opacity: 0.7 }]} onPress={handleSignUp} disabled={loading} activeOpacity={0.85}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>Create Account</Text>}
        </TouchableOpacity>

        <View style={s.footer}>
          <Text style={s.footerText}>Already have an account? </Text>
          <Link href="/(auth)/sign-in" asChild>
            <TouchableOpacity><Text style={s.footerLink}>Sign In</Text></TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  inner: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 28, paddingVertical: 40 },
  header: { alignItems: "center", marginBottom: 40 },
  title: { fontSize: 30, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 16, color: colors.textSecondary, marginTop: 6 },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1.5, marginBottom: 8, marginLeft: 4 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.xl, paddingHorizontal: 20, paddingVertical: 16, color: colors.text, fontSize: 16 },
  button: { backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16, alignItems: "center", marginTop: 32 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 24 },
  footerText: { color: colors.textSecondary, fontSize: 15 },
  footerLink: { color: colors.primary, fontWeight: "700", fontSize: 15 },
});
