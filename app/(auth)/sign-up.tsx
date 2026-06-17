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
  Linking,
  StyleSheet,
} from "react-native";
import { Link, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import { colors, radius, spacing } from "@/lib/theme";

// TODO: replace with your hosted legal pages before submitting to the App Store.
const TERMS_URL = "https://castapp.com/terms";
const PRIVACY_URL = "https://castapp.com/privacy";

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSignUp() {
    if (!displayName || !email || !password) {
      Alert.alert("Error", "Please fill in all fields");
      return;
    }
    if (!agreed) {
      Alert.alert("Agree to continue", "Please accept the Terms and content policy to create an account.");
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
          <Text style={s.subtitle}>Join the Prelogue community</Text>
        </View>

        <Text style={s.label}>DISPLAY NAME</Text>
        <TextInput style={s.input} placeholder="Your name" placeholderTextColor={colors.textMuted} value={displayName} onChangeText={setDisplayName} />

        <Text style={[s.label, { marginTop: spacing.lg }]}>EMAIL</Text>
        <TextInput style={s.input} placeholder="you@example.com" placeholderTextColor={colors.textMuted} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />

        <Text style={[s.label, { marginTop: spacing.lg }]}>PASSWORD</Text>
        <TextInput style={s.input} placeholder="At least 6 characters" placeholderTextColor={colors.textMuted} value={password} onChangeText={setPassword} secureTextEntry />

        <TouchableOpacity style={s.agreeRow} onPress={() => setAgreed((v) => !v)} activeOpacity={0.7}>
          <View style={[s.checkbox, agreed && s.checkboxOn]}>
            {agreed ? <Feather name="check" size={13} color="#fff" /> : null}
          </View>
          <Text style={s.agreeText}>
            I agree to the{" "}
            <Text style={s.agreeLink} onPress={() => Linking.openURL(TERMS_URL)}>Terms of Use</Text> and{" "}
            <Text style={s.agreeLink} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>. I understand
            Prelogue has zero tolerance for objectionable content or abusive behavior.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={[s.button, (loading || !agreed) && { opacity: 0.5 }]} onPress={handleSignUp} disabled={loading || !agreed} activeOpacity={0.85}>
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
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 24 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.cardBorder,
    alignItems: "center", justifyContent: "center", marginTop: 1,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  agreeText: { flex: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  agreeLink: { color: colors.primary, fontWeight: "600" },
  button: { backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16, alignItems: "center", marginTop: 24 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 24 },
  footerText: { color: colors.textSecondary, fontSize: 15 },
  footerLink: { color: colors.primary, fontWeight: "700", fontSize: 15 },
});
