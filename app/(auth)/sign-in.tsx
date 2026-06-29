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
import { useRouter } from "expo-router";
import { supabase } from "@/lib/supabase";
import { colors, radius, spacing } from "@/lib/theme";

export default function SignInScreen() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendCode() {
    const e = email.trim();
    if (!e) {
      Alert.alert("Enter your email", "We'll send a 6-digit code to sign you in.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: e,
      options: { shouldCreateUser: true },
    });
    setLoading(false);
    if (error) {
      Alert.alert("Couldn't send code", error.message);
      return;
    }
    setStep("code");
  }

  async function verify() {
    if (code.length < 6) return;
    setLoading(true);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    if (error) {
      setLoading(false);
      Alert.alert("Invalid or expired code", error.message);
      return;
    }
    // New users (no role yet) → onboarding; returning users → the app.
    let hasRole = false;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: prof } = await supabase
        .from("users")
        .select("role, roles")
        .eq("id", user.id)
        .single();
      const p = prof as { role?: string | null; roles?: string[] | null } | null;
      hasRole = !!(p?.role || (Array.isArray(p?.roles) && p.roles.length));
    }
    setLoading(false);
    router.replace((hasRole ? "/(tabs)" : "/(auth)/onboarding") as any);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={s.container}
    >
      <View style={s.inner}>
        <View style={s.logoSection}>
          <View style={s.logoBox}>
            <Text style={s.logoLetter}>P</Text>
          </View>
          <Text style={s.appName}>Prelogue</Text>
          <Text style={s.tagline}>Table reads, reimagined</Text>
        </View>

        {step === "email" ? (
          <>
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
              editable={!loading}
            />
            <TouchableOpacity
              style={[s.button, loading && { opacity: 0.7 }]}
              onPress={sendCode}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>Email me a code</Text>}
            </TouchableOpacity>
            <Text style={s.hint}>We&rsquo;ll email you a 6-digit code — no password needed.</Text>
          </>
        ) : (
          <>
            <Text style={s.label}>6-DIGIT CODE</Text>
            <TextInput
              style={[s.input, s.codeInput]}
              placeholder="••••••"
              placeholderTextColor={colors.textMuted}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
              autoFocus
              editable={!loading}
            />
            <Text style={s.sentTo}>Sent to {email}</Text>
            <TouchableOpacity
              style={[s.button, (loading || code.length < 6) && { opacity: 0.7 }]}
              onPress={verify}
              disabled={loading || code.length < 6}
              activeOpacity={0.85}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>Verify &amp; continue</Text>}
            </TouchableOpacity>
            <View style={s.codeFooter}>
              <TouchableOpacity
                onPress={() => {
                  setStep("email");
                  setCode("");
                }}
              >
                <Text style={s.footerLink}>← Different email</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={sendCode} disabled={loading}>
                <Text style={s.footerLink}>Resend code</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
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
  logoLetter: { color: "#fff", fontSize: 32, fontFamily: "RobotoSlab_700Bold" },
  appName: { fontSize: 44, fontFamily: "RobotoSlab_700Bold", color: colors.text, letterSpacing: -1 },
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
  codeInput: { textAlign: "center", fontSize: 30, letterSpacing: 10, fontWeight: "700" },
  button: {
    backgroundColor: colors.primary, borderRadius: radius.xl,
    paddingVertical: 16, alignItems: "center", marginTop: 20,
  },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16, letterSpacing: 0.3 },
  hint: { color: colors.textMuted, fontSize: 13, textAlign: "center", marginTop: 16 },
  sentTo: { color: colors.textSecondary, fontSize: 14, textAlign: "center", marginTop: 12 },
  codeFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 22 },
  footerLink: { color: colors.primary, fontWeight: "700", fontSize: 14 },
});
