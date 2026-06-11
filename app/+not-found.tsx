import { Link, Stack } from "expo-router";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius, spacing } from "@/lib/theme";

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Oops!", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
      <View style={s.container}>
        <Text style={s.title}>
          This screen doesn't exist.
        </Text>
        <Link href="/" style={s.link}>
          <Text style={s.linkText}>Go to home screen!</Text>
        </Link>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: colors.bg,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
  },
  link: {
    marginTop: spacing.lg,
    paddingVertical: spacing.lg,
  },
  linkText: {
    color: colors.primary,
    fontSize: 14,
  },
});
