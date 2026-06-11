import { TouchableOpacity, Share, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, radius } from "@/lib/theme";

interface Props {
  title: string;
  message?: string;
  url?: string;
}

export function ShareButton({ title, message, url }: Props) {
  async function handleShare() {
    try {
      await Share.share({
        title,
        message: message || title,
        url: url || undefined,
      });
    } catch (err) {
      console.error("Share error:", err);
    }
  }

  return (
    <TouchableOpacity style={s.btn} onPress={handleShare} activeOpacity={0.7}>
      <Feather name="share" size={16} color={colors.textSecondary} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  btn: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.elevated,
    alignItems: "center",
    justifyContent: "center",
  },
});
