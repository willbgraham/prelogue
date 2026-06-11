import { useEffect, useRef } from "react";
import { View, Animated, StyleSheet, ViewStyle } from "react-native";
import { colors, radius } from "@/lib/theme";

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
}

/**
 * Shimmer skeleton placeholder for loading states.
 */
export function Skeleton({
  width = "100%",
  height = 16,
  borderRadius = radius.md,
  style,
}: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.7,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          borderRadius,
          backgroundColor: colors.cardBorder,
          opacity,
        },
        style,
      ]}
    />
  );
}

/**
 * Pre-built skeleton layouts for common screen patterns.
 */
export function ScriptCardSkeleton() {
  return (
    <View style={sk.card}>
      <Skeleton height={3} borderRadius={0} />
      <View style={sk.cardBody}>
        <View style={sk.row}>
          <Skeleton width={60} height={24} borderRadius={radius.full} />
          <Skeleton width={50} height={16} />
        </View>
        <Skeleton width="80%" height={22} style={{ marginTop: 12 }} />
        <Skeleton width="100%" height={14} style={{ marginTop: 8 }} />
        <Skeleton width="60%" height={14} style={{ marginTop: 4 }} />
        <View style={[sk.row, { marginTop: 16, borderTopWidth: 1, borderTopColor: colors.cardBorder, paddingTop: 12 }]}>
          <Skeleton width={80} height={14} />
          <Skeleton width={90} height={32} borderRadius={radius.lg} />
        </View>
      </View>
    </View>
  );
}

export function LeaderboardRowSkeleton() {
  return (
    <View style={sk.leaderRow}>
      <Skeleton width={32} height={32} borderRadius={16} />
      <Skeleton width={40} height={40} borderRadius={20} style={{ marginLeft: 12 }} />
      <Skeleton width={120} height={16} style={{ marginLeft: 12 }} />
      <View style={{ flex: 1 }} />
      <Skeleton width={50} height={24} borderRadius={radius.full} />
    </View>
  );
}

export function ProfileSkeleton() {
  return (
    <View style={sk.profileWrap}>
      <View style={sk.profileHeader}>
        <Skeleton width={80} height={80} borderRadius={radius.lg} />
        <Skeleton width={150} height={20} style={{ marginTop: 12 }} />
        <Skeleton width={80} height={20} borderRadius={radius.full} style={{ marginTop: 8 }} />
      </View>
    </View>
  );
}

export function CharacterCardSkeleton() {
  return (
    <View style={sk.card}>
      <View style={[sk.cardBody, { flexDirection: "row", alignItems: "center" }]}>
        <Skeleton width={44} height={44} borderRadius={radius.md} />
        <View style={{ marginLeft: 12, flex: 1 }}>
          <Skeleton width="60%" height={16} />
          <Skeleton width="40%" height={12} style={{ marginTop: 6 }} />
        </View>
      </View>
    </View>
  );
}

const sk = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 16,
    overflow: "hidden",
  },
  cardBody: {
    padding: 20,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  leaderRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  profileWrap: {
    margin: 20,
  },
  profileHeader: {
    backgroundColor: colors.card,
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 24,
    alignItems: "center",
  },
});
