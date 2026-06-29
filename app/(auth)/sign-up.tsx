import { useEffect } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

// Passwordless now — one email-code flow handles both sign-in and sign-up.
export default function SignUpScreen() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/(auth)/sign-in" as any);
  }, [router]);
  return <View />;
}
