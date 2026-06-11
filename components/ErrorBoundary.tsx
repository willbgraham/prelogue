import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, radius, spacing } from "@/lib/theme";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Custom error boundary with dark-themed UI and retry button.
 */
export class AppErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("App Error:", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={s.container}>
          <View style={s.iconWrap}>
            <Feather name="alert-triangle" size={40} color={colors.red} />
          </View>
          <Text style={s.title}>Something went wrong</Text>
          <Text style={s.message}>
            {this.state.error?.message || "An unexpected error occurred"}
          </Text>
          <TouchableOpacity style={s.retryBtn} onPress={this.handleRetry} activeOpacity={0.85}>
            <Feather name="refresh-cw" size={16} color="#fff" />
            <Text style={s.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: radius.xxl,
    backgroundColor: colors.redMuted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xxl,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: colors.text,
    marginBottom: spacing.sm,
  },
  message: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: spacing.xxxl,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
    paddingHorizontal: 24,
    paddingVertical: 14,
    gap: 8,
  },
  retryText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
});
