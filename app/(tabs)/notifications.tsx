import { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  SectionList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Animated,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { NOTIFICATION_LABELS } from "@/lib/constants";
import { ErrorState } from "@/components/ErrorState";
import type { Notification as AppNotification } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import { colors, radius, spacing, fonts } from "@/lib/theme";

// ---------------------------------------------------------------------------
// Icon config per notification type
// ---------------------------------------------------------------------------
const ICON_MAP: Record<
  string,
  { name: React.ComponentProps<typeof Feather>["name"]; color: string; bg: string }
> = {
  new_script: { name: "book-open", color: colors.teal, bg: colors.tealMuted },
  new_submission: { name: "video", color: colors.primary, bg: colors.primaryMuted },
  writers_choice: { name: "award", color: colors.yellow, bg: colors.yellowMuted },
  assembly_ready: { name: "play-circle", color: colors.green, bg: colors.greenMuted },
  audience_vote: { name: "heart", color: colors.red, bg: colors.redMuted },
  new_comment: { name: "message-circle", color: "#a29bfe", bg: "rgba(162,155,254,0.15)" },
};

const FALLBACK_ICON = { name: "bell" as const, color: colors.primary, bg: colors.primaryMuted };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Skeleton placeholder rows while loading
// ---------------------------------------------------------------------------
function SkeletonRow({ delay }: { delay: number }) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, delay, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  return (
    <Animated.View style={[s.skeletonRow, { opacity }]}>
      <View style={s.skeletonIcon} />
      <View style={s.skeletonContent}>
        <View style={s.skeletonTitle} />
        <View style={s.skeletonBody} />
      </View>
    </Animated.View>
  );
}

function LoadingSkeleton() {
  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Notifications</Text>
      </View>
      <View style={{ padding: spacing.xl }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonRow key={i} delay={i * 120} />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------
function SignInPrompt() {
  const router = useRouter();
  return (
    <View style={s.container}>
      <View style={s.centeredFill}>
        <View style={s.signInCard}>
          <View style={s.signInIconWrap}>
            <Feather name="lock" size={28} color={colors.primary} />
          </View>
          <Text style={s.signInTitle}>Sign in to view notifications</Text>
          <Text style={s.signInBody}>
            Create an account or sign in to stay up to date with scripts, auditions, and table
            reads.
          </Text>
          <TouchableOpacity
            style={s.signInButton}
            activeOpacity={0.8}
            onPress={() => router.push("/(auth)/login" as any)}
          >
            <Text style={s.signInButtonText}>Sign In</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function EmptyState() {
  return (
    <View style={s.emptyContainer}>
      <View style={s.emptyIconBox}>
        <Feather name="bell-off" size={32} color={colors.textMuted} />
      </View>
      <Text style={s.emptyTitle}>All caught up!</Text>
      <Text style={s.emptyText}>
        When there is activity on your scripts, submissions, or table reads, you will see it here.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
export default function NotificationsScreen() {
  const { session, loading: authLoading } = useAuth();
  const router = useRouter();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // -----------------------------------------------------------------------
  // Fetch
  // -----------------------------------------------------------------------
  const fetchNotifications = useCallback(async () => {
    if (!session) return;
    try {
      const { data, error: queryError } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", session.user.id)
        .order("created_at", { ascending: false })
        .limit(80);
      if (queryError) throw queryError;
      setNotifications((data ?? []) as AppNotification[]);
      setError(false);
    } catch (e) {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [session]);

  const retry = useCallback(() => {
    setLoading(true);
    fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    if (session) fetchNotifications();
  }, [session]);

  // -----------------------------------------------------------------------
  // Realtime — auto-prepend new notifications
  // -----------------------------------------------------------------------
  useRealtimeSubscription(
    "notifications-insert",
    {
      event: "INSERT",
      schema: "public",
      table: "notifications",
      filter: session ? `user_id=eq.${session.user.id}` : undefined,
    },
    useCallback(
      (payload: any) => {
        if (payload?.new) {
          setNotifications((prev) => [payload.new as AppNotification, ...prev]);
        }
      },
      []
    )
  );

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------
  async function markAllRead() {
    if (!session) return;
    await supabase
      .from("notifications")
      .update({ read: true })
      .eq("user_id", session.user.id)
      .eq("read", false);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  async function markRead(id: string) {
    await supabase.from("notifications").update({ read: true }).eq("id", id);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }

  async function deleteNotification(id: string) {
    await supabase.from("notifications").delete().eq("id", id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }

  function handlePress(item: AppNotification) {
    if (!item.read) markRead(item.id);
    const p = item.payload as Record<string, any>;
    if (p?.script_id) {
      router.push(`/script/${p.script_id}` as any);
    } else if (p?.assembled_read_id) {
      router.push(`/table-read/${p.assembled_read_id}` as any);
    } else if (p?.submission_id && p?.character_id) {
      router.push(`/role/${p.character_id}` as any);
    }
  }

  function handleLongPress(item: AppNotification) {
    Alert.alert("Delete notification?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => deleteNotification(item.id),
      },
    ]);
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchNotifications();
    setRefreshing(false);
  }, [fetchNotifications]);

  // -----------------------------------------------------------------------
  // Auth guard
  // -----------------------------------------------------------------------
  if (authLoading) return <LoadingSkeleton />;
  if (!session) return <SignInPrompt />;
  if (loading) return <LoadingSkeleton />;
  if (error && notifications.length === 0) {
    return (
      <View style={s.container}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Notifications</Text>
        </View>
        <View style={s.centeredFill}>
          <ErrorState onRetry={retry} />
        </View>
      </View>
    );
  }

  // -----------------------------------------------------------------------
  // Sections
  // -----------------------------------------------------------------------
  const unread = notifications.filter((n) => !n.read);
  const read = notifications.filter((n) => n.read);
  const unreadCount = unread.length;

  type Section = { title: string; data: AppNotification[] };
  const sections: Section[] = [];
  if (unread.length > 0) sections.push({ title: "New", data: unread });
  if (read.length > 0) sections.push({ title: "Earlier", data: read });

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.headerTitle}>Notifications</Text>
          {unreadCount > 0 && (
            <View style={s.badge}>
              <Text style={s.badgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
            </View>
          )}
        </View>
        {unreadCount > 0 && (
          <TouchableOpacity
            onPress={markAllRead}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            activeOpacity={0.7}
          >
            <Text style={s.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          sections.length === 0 ? s.emptyListContent : { paddingBottom: 40 }
        }
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListEmptyComponent={<EmptyState />}
        renderSectionHeader={({ section }) => (
          <View style={s.sectionHeader}>
            <Text style={s.sectionHeaderText}>{section.title}</Text>
            {section.title === "New" && (
              <View style={s.sectionDot} />
            )}
          </View>
        )}
        renderItem={({ item }) => {
          const icon = ICON_MAP[item.type] ?? FALLBACK_ICON;
          const message = (item.payload as any)?.message as string | undefined;

          return (
            <TouchableOpacity
              style={[s.notifRow, item.read ? s.notifRead : s.notifUnread]}
              onPress={() => handlePress(item)}
              onLongPress={() => handleLongPress(item)}
              activeOpacity={0.7}
              delayLongPress={500}
            >
              {/* Icon */}
              <View style={[s.notifIcon, { backgroundColor: icon.bg }]}>
                <Feather name={icon.name} size={18} color={icon.color} />
              </View>

              {/* Content */}
              <View style={s.notifContent}>
                <View style={s.notifTopRow}>
                  <Text style={s.notifTitle} numberOfLines={1}>
                    {NOTIFICATION_LABELS[item.type] ?? item.type}
                  </Text>
                  <Text style={s.notifTime}>{relativeTime(item.created_at)}</Text>
                </View>
                {message ? (
                  <Text style={s.notifBody} numberOfLines={2}>
                    {message}
                  </Text>
                ) : null}
              </View>

              {/* Unread dot */}
              {!item.read && <View style={s.unreadDot} />}
            </TouchableOpacity>
          );
        }}
        ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
        SectionSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s = StyleSheet.create({
  // Layout
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centeredFill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: 60,
    paddingBottom: spacing.lg,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.elevated,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headerTitle: {
    ...fonts.heading,
    fontSize: 24,
  },
  badge: {
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
  markAllText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "600",
  },

  // Sections
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
  },
  sectionHeaderText: {
    ...fonts.caption,
    color: colors.textSecondary,
  },
  sectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },

  // Notification row
  notifRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginHorizontal: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  notifRead: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
  },
  notifUnread: {
    backgroundColor: "rgba(188, 64, 38, 0.06)",
    borderColor: "rgba(188, 64, 38, 0.25)",
  },
  notifIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  notifContent: {
    flex: 1,
  },
  notifTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  notifTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
    marginRight: spacing.sm,
  },
  notifTime: {
    color: colors.textMuted,
    fontSize: 11,
  },
  notifBody: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    marginLeft: spacing.sm,
  },

  // Empty
  emptyListContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: spacing.xl,
  },
  emptyContainer: {
    backgroundColor: colors.card,
    borderRadius: radius.xxl,
    padding: spacing.xxxl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginHorizontal: spacing.xl,
  },
  emptyIconBox: {
    width: 72,
    height: 72,
    borderRadius: radius.xl,
    backgroundColor: colors.elevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: spacing.xs,
  },
  emptyText: {
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 20,
  },

  // Sign-in prompt
  signInCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xxl,
    padding: spacing.xxxl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.cardBorder,
    width: "100%",
    maxWidth: 360,
  },
  signInIconWrap: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  signInTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: spacing.sm,
    textAlign: "center",
  },
  signInBody: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: spacing.xxl,
  },
  signInButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxxl,
  },
  signInButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },

  // Skeleton
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
  },
  skeletonIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.elevated,
    marginRight: spacing.md,
  },
  skeletonContent: {
    flex: 1,
    gap: spacing.sm,
  },
  skeletonTitle: {
    height: 14,
    width: "60%",
    borderRadius: radius.sm,
    backgroundColor: colors.elevated,
  },
  skeletonBody: {
    height: 12,
    width: "40%",
    borderRadius: radius.sm,
    backgroundColor: colors.elevated,
  },
});
