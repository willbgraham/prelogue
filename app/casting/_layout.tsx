import { Stack } from "expo-router";
import { HeaderBackButton } from "@/components/HeaderBackButton";
import { colors } from "@/lib/theme";

export default function CastingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "700" },
        headerLeft: ({ tintColor }) => <HeaderBackButton tintColor={tintColor} />,
      }}
    />
  );
}
