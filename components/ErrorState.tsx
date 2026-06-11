import { View, Text, TouchableOpacity, StyleSheet, ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, radius, spacing } from "@/lib/theme";

interface ErrorStateProps {
  message?: string;
  onRetry: () => void;
  style?: ViewStyle;
}

/**
 * Recoverable error card shown when a data fetch fails. Gives the user a clear
 * "Try Again" action instead of a stuck loading state or a misleading empty state.
 */
export function ErrorState({
  message = "We couldn't load this. Check your connection and try again.",
  onRetry,
  style,
}: ErrorStateProps) {
  return (
    <View style={[s.card, style]}>
      <View style={s.iconBox}>
        <Feather name="wifi-off" size={28} color={colors.textMuted} />
      </View>
      <Text style={s.title}>Something went wrong</Text>
      <Text style={s.body}>{message}</Text>
      <TouchableOpacity style={s.retryBtn} onPress={onRetry} activeOpacity={0.85}>
        <Feather name="refresh-cw" size={16} color="#fff" />
        <Text style={s.retryText}>Try Again</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    marginHorizontal: spacing.xl,
    backgroundColor: colors.card,
    borderRadius: radius.xxl,
    padding: spacing.xxxl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  iconBox: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    backgroundColor: colors.elevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
    marginBottom: spacing.xs,
  },
  body: {
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: spacing.xl,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    gap: 8,
  },
  retryText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
