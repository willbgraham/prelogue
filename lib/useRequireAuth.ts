import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { useAuth } from "./auth";

/**
 * Returns a guard function that checks if user is authenticated.
 * If not, shows an alert and redirects to sign-in.
 * Use before any protected action (audition, submit, comment, etc.)
 */
export function useRequireAuth() {
  const { session, profile } = useAuth();
  const router = useRouter();

  function requireAuth(action?: string): boolean {
    if (!session) {
      Alert.alert(
        "Sign In Required",
        action
          ? `You need to sign in to ${action}.`
          : "You need to sign in to do that.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Sign In",
            onPress: () => router.push("/(auth)/sign-in" as any),
          },
        ]
      );
      return false;
    }
    if (!profile?.role) {
      router.push("/(auth)/onboarding" as any);
      return false;
    }
    return true;
  }

  return { requireAuth, isAuthed: !!session, profile };
}
