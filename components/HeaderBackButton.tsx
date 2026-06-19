import { useRouter } from "expo-router";
import { TouchableOpacity } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors } from "@/lib/theme";

/**
 * Explicit header back button for nested stacks.
 *
 * Each route group (script/, role/, recording/, ...) is a nested stack whose
 * first screen gets no automatic back button — the parent stack that holds the
 * navigation history has its header hidden. This provides a reliable way back.
 *
 * `tintColor` is supplied by React Navigation and matches the screen's
 * headerTintColor, so the chevron stays visible on both dark and light headers.
 */
export function HeaderBackButton({ tintColor }: { tintColor?: string }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      onPress={() =>
        router.canGoBack() ? router.back() : router.replace("/(tabs)" as any)
      }
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={{ paddingRight: 20 }}
    >
      <Feather name="chevron-left" size={26} color={tintColor ?? colors.text} />
    </TouchableOpacity>
  );
}
