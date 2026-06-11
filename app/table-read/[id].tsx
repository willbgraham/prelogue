import { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Alert,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Easing,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useRequireAuth } from "@/lib/useRequireAuth";
import { exportToYouTube } from "@/lib/youtube";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import type { AssembledRead, Comment, Submission } from "@/lib/types";
import { formatDistanceToNow, format } from "date-fns";
import { colors, spacing, radius, fonts } from "@/lib/theme";
import { VideoPlayer } from "@/components/VideoPlayer";
import { ShareButton } from "@/components/ShareButton";

// ---------------------------------------------------------------------------
// Genre color mapping (shared convention across the app)
// ---------------------------------------------------------------------------
const genreColorMap: Record<string, string> = {
  "Sci-Fi": colors.teal,
  Drama: colors.orange,
  Comedy: colors.yellow,
  Horror: colors.red,
  Thriller: colors.red,
  Romance: colors.pink,
  Action: colors.red,
  Fantasy: colors.primary,
  Mystery: colors.teal,
};

function getGenreColor(genre?: string): string {
  if (!genre) return colors.primary;
  return genreColorMap[genre] || colors.primary;
}

// ---------------------------------------------------------------------------
// Animated processing dots
// ---------------------------------------------------------------------------
function ProcessingDots() {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    function animate(dot: Animated.Value, delay: number) {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, {
            toValue: 1,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0.3,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
    }
    const a1 = animate(dot1, 0);
    const a2 = animate(dot2, 200);
    const a3 = animate(dot3, 400);
    a1.start();
    a2.start();
    a3.start();
    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, []);

  return (
    <View style={s.dotsRow}>
      {[dot1, dot2, dot3].map((dot, i) => (
        <Animated.View
          key={i}
          style={[s.dot, { opacity: dot, transform: [{ scale: dot }] }]}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Cast member card for horizontal scroll
// ---------------------------------------------------------------------------
interface CastMember {
  actorId: string;
  actorName: string;
  characterName: string;
}

function CastCard({
  member,
  onPress,
}: {
  member: CastMember;
  onPress: () => void;
}) {
  const initial = (member.actorName || "?")[0].toUpperCase();
  return (
    <TouchableOpacity
      style={s.castCard}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={s.castAvatar}>
        <Text style={s.castAvatarText}>{initial}</Text>
      </View>
      <Text style={s.castActorName} numberOfLines={1}>
        {member.actorName}
      </Text>
      <Text style={s.castCharName} numberOfLines={1}>
        as {member.characterName}
      </Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Single comment row
// ---------------------------------------------------------------------------
function CommentRow({ comment }: { comment: Comment }) {
  const user = (comment as any).user;
  const name = user?.display_name ?? "User";
  const initial = name[0].toUpperCase();

  return (
    <View style={s.commentRow}>
      <View style={s.commentAvatar}>
        <Text style={s.commentAvatarLetter}>{initial}</Text>
      </View>
      <View style={s.commentBubble}>
        <View style={s.commentHeader}>
          <Text style={s.commentAuthor}>{name}</Text>
          <Text style={s.commentTime}>
            {formatDistanceToNow(new Date(comment.created_at), {
              addSuffix: true,
            })}
          </Text>
        </View>
        <Text style={s.commentBody}>{comment.body}</Text>
      </View>
    </View>
  );
}

// ===========================================================================
// Main Screen
// ===========================================================================
export default function TableReadViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const { requireAuth } = useRequireAuth();
  const router = useRouter();

  const [read, setRead] = useState<AssembledRead | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [cast, setCast] = useState<CastMember[]>([]);
  const [newComment, setNewComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const commentInputRef = useRef<TextInput>(null);

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------
  const fetchRead = useCallback(async () => {
    const { data } = await supabase
      .from("assembled_reads")
      .select(
        "*, script:scripts!assembled_reads_script_id_fkey(id, title, genre, writer:users!scripts_writer_id_fkey(id, display_name))"
      )
      .eq("id", id)
      .single();
    if (data) setRead(data as any);
    return data as any;
  }, [id]);

  const fetchComments = useCallback(async () => {
    const { data } = await supabase
      .from("comments")
      .select(
        "*, user:users!comments_user_id_fkey(id, display_name, avatar_url)"
      )
      .eq("assembled_read_id", id)
      .order("created_at", { ascending: true });
    if (data) setComments(data as any);
  }, [id]);

  const fetchCast = useCallback(
    async (scriptId: string) => {
      const { data } = await supabase
        .from("submissions")
        .select(
          "id, actor:users!submissions_actor_id_fkey(id, display_name), character:characters!submissions_character_id_fkey(id, name)"
        )
        .eq("script_id", scriptId)
        .eq("is_writers_choice", true);

      if (data) {
        const members: CastMember[] = data.map((sub: any) => ({
          actorId: sub.actor?.id ?? "",
          actorName: sub.actor?.display_name ?? "Unknown",
          characterName: sub.character?.name ?? "Unknown",
        }));
        setCast(members);
      }
    },
    []
  );

  useEffect(() => {
    async function init() {
      const readData = await fetchRead();
      await fetchComments();
      if (readData?.script_id) {
        await fetchCast(readData.script_id);
      }
      setLoading(false);
      // Increment view count (fire & forget)
      supabase.rpc("increment_view_count", { read_id: id });
    }
    init();
  }, [id]);

  // -----------------------------------------------------------------------
  // Realtime: status changes (processing -> ready)
  // -----------------------------------------------------------------------
  useRealtimeSubscription(
    `table-read-status-${id}`,
    {
      event: "UPDATE",
      schema: "public",
      table: "assembled_reads",
      filter: `id=eq.${id}`,
    },
    (payload: any) => {
      if (payload.new) {
        setRead((prev) =>
          prev ? { ...prev, ...payload.new } : payload.new
        );
      }
    }
  );

  // -----------------------------------------------------------------------
  // Realtime: new comments
  // -----------------------------------------------------------------------
  useRealtimeSubscription(
    `table-read-comments-${id}`,
    {
      event: "INSERT",
      schema: "public",
      table: "comments",
      filter: `assembled_read_id=eq.${id}`,
    },
    async (payload: any) => {
      // Fetch the full comment with user join
      const { data } = await supabase
        .from("comments")
        .select(
          "*, user:users!comments_user_id_fkey(id, display_name, avatar_url)"
        )
        .eq("id", payload.new.id)
        .single();
      if (data) {
        setComments((prev) => {
          // Avoid duplicates (in case we already added it optimistically)
          if (prev.some((c) => c.id === data.id)) return prev;
          return [...prev, data as any];
        });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Post comment
  // -----------------------------------------------------------------------
  async function postComment() {
    const body = newComment.trim();
    if (!body) return;
    if (!requireAuth("post a comment")) return;
    if (!session) return;
    setPosting(true);
    try {
      const { error } = await supabase.from("comments").insert({
        user_id: session.user.id,
        assembled_read_id: id,
        body,
      });
      if (error) throw error;
      setNewComment("");
      commentInputRef.current?.blur();
      // The realtime subscription will pick up the new comment
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setPosting(false);
    }
  }

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------
  if (loading || !read) {
    return (
      <View style={s.loadingContainer}>
        <Stack.Screen
          options={{
            title: "",
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            headerShadowVisible: false,
          }}
        />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // -----------------------------------------------------------------------
  // Derived data
  // -----------------------------------------------------------------------
  const script = (read as any).script;
  const writerName = script?.writer?.display_name ?? "Unknown";
  const genreColor = getGenreColor(script?.genre);
  const formattedDate = format(new Date(read.created_at), "MMM d, yyyy");
  const isReady = read.status === "ready" && !!read.video_url;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <>
      <Stack.Screen
        options={{
          title: "",
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          headerTransparent: false,
        }}
      />
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <ScrollView
          ref={scrollRef}
          style={s.container}
          contentContainerStyle={s.contentContainer}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ============================================================= */}
          {/* VIDEO PLAYER                                                   */}
          {/* ============================================================= */}
          {isReady ? (
            <View style={s.videoWrapper}>
              <VideoPlayer url={read.video_url!} aspectRatio={16 / 9} />
            </View>
          ) : read.status === "processing" ? (
            <View style={s.videoPlaceholder}>
              <View style={s.processingContainer}>
                <Feather
                  name="film"
                  size={36}
                  color={colors.primary}
                  style={{ marginBottom: spacing.md }}
                />
                <Text style={s.processingTitle}>Assembling your table read</Text>
                <Text style={s.processingSubtitle}>
                  This may take a few minutes
                </Text>
                <ProcessingDots />
              </View>
            </View>
          ) : (
            <View style={s.videoPlaceholder}>
              <Feather name="video-off" size={36} color={colors.textMuted} />
              <Text style={s.videoUnavailableText}>Video not available</Text>
            </View>
          )}

          {/* ============================================================= */}
          {/* INFO SECTION                                                   */}
          {/* ============================================================= */}
          <View style={s.infoSection}>
            <Text style={s.title}>{script?.title ?? "Table Read"}</Text>
            <Text style={s.subtitle}>by {writerName}</Text>

            {/* Meta row: genre badge, views, date */}
            <View style={s.metaRow}>
              {script?.genre ? (
                <View
                  style={[
                    s.genreBadge,
                    { backgroundColor: genreColor + "20" },
                  ]}
                >
                  <Text style={[s.genreBadgeText, { color: genreColor }]}>
                    {script.genre}
                  </Text>
                </View>
              ) : null}

              <View style={s.metaItem}>
                <Feather name="eye" size={13} color={colors.textMuted} />
                <Text style={s.metaText}>
                  {read.view_count.toLocaleString()}{" "}
                  {read.view_count === 1 ? "view" : "views"}
                </Text>
              </View>

              <View style={s.metaItem}>
                <Feather name="calendar" size={13} color={colors.textMuted} />
                <Text style={s.metaText}>{formattedDate}</Text>
              </View>
            </View>

            {/* Action bar */}
            <View style={s.actionBar}>
              <ShareButton
                title={script?.title ?? "Table Read"}
                message={`Check out this table read: ${script?.title ?? ""}`}
              />

              {isReady && (
                <TouchableOpacity
                  style={s.youtubeBtn}
                  onPress={() =>
                    exportToYouTube(
                      read.id,
                      script?.title ?? "",
                      script?.genre ?? "",
                      cast.map((c) => `${c.actorName} as ${c.characterName}`)
                    )
                  }
                  activeOpacity={0.7}
                >
                  <Feather name="youtube" size={16} color="#FF0000" />
                  <Text style={s.youtubeBtnText}>Export to YouTube</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Divider */}
          <View style={s.divider} />

          {/* ============================================================= */}
          {/* CAST LIST                                                      */}
          {/* ============================================================= */}
          {cast.length > 0 && (
            <View style={s.castSection}>
              <View style={s.sectionHeader}>
                <View style={s.sectionAccent} />
                <Text style={s.sectionTitle}>Cast</Text>
                <Text style={s.sectionCount}>{cast.length}</Text>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.castScroll}
              >
                {cast.map((member) => (
                  <CastCard
                    key={member.actorId}
                    member={member}
                    onPress={() =>
                      router.push(`/actor/${member.actorId}` as any)
                    }
                  />
                ))}
              </ScrollView>

              <View style={s.divider} />
            </View>
          )}

          {/* ============================================================= */}
          {/* COMMENTS                                                       */}
          {/* ============================================================= */}
          <View style={s.commentsSection}>
            <View style={s.sectionHeader}>
              <View style={s.sectionAccent} />
              <Text style={s.sectionTitle}>Comments</Text>
              <Text style={s.sectionCount}>{comments.length}</Text>
            </View>

            {comments.length === 0 ? (
              <View style={s.emptyComments}>
                <Feather
                  name="message-circle"
                  size={32}
                  color={colors.textMuted}
                />
                <Text style={s.emptyTitle}>No comments yet</Text>
                <Text style={s.emptySubtitle}>
                  Be the first to share your thoughts
                </Text>
              </View>
            ) : (
              comments.map((comment) => (
                <CommentRow key={comment.id} comment={comment} />
              ))
            )}
          </View>

          {/* Bottom spacer so comment input doesn't overlap last comment */}
          <View style={{ height: 80 }} />
        </ScrollView>

        {/* ============================================================= */}
        {/* COMMENT INPUT (pinned to bottom)                               */}
        {/* ============================================================= */}
        <View style={s.commentInputBar}>
          <TextInput
            ref={commentInputRef}
            style={s.commentInput}
            placeholder="Add a comment..."
            placeholderTextColor={colors.textMuted}
            value={newComment}
            onChangeText={setNewComment}
            multiline
            maxLength={500}
            returnKeyType="default"
          />
          <TouchableOpacity
            style={[
              s.sendBtn,
              (!newComment.trim() || posting) && s.sendBtnDisabled,
            ]}
            onPress={postComment}
            disabled={posting || !newComment.trim()}
            activeOpacity={0.7}
          >
            {posting ? (
              <ActivityIndicator color="white" size="small" />
            ) : (
              <Feather name="send" size={16} color="white" />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

// ===========================================================================
// Styles
// ===========================================================================
const s = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  contentContainer: {
    paddingBottom: spacing.lg,
  },

  // Video -----------------------------------------------------------------
  videoWrapper: {
    width: "100%",
    backgroundColor: "#000",
  },
  videoPlaceholder: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  processingContainer: {
    alignItems: "center",
  },
  processingTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  processingSubtitle: {
    color: colors.textMuted,
    fontSize: 13,
    marginBottom: spacing.lg,
  },
  dotsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },
  videoUnavailableText: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: spacing.sm,
  },

  // Info ------------------------------------------------------------------
  infoSection: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  title: {
    ...fonts.heading,
    lineHeight: 34,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    marginTop: spacing.md,
    gap: spacing.md,
  },
  genreBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  genreBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  metaText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  youtubeBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  youtubeBtnText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 13,
  },

  // Divider ---------------------------------------------------------------
  divider: {
    height: 1,
    backgroundColor: colors.cardBorder,
    marginHorizontal: spacing.xl,
    marginVertical: spacing.xl,
  },

  // Cast ------------------------------------------------------------------
  castSection: {
    paddingTop: 0,
  },
  castScroll: {
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  castCard: {
    width: 100,
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  castAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  castAvatarText: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.primary,
  },
  castActorName: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    textAlign: "center",
  },
  castCharName: {
    fontSize: 11,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: 2,
  },

  // Section headers -------------------------------------------------------
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.lg,
  },
  sectionAccent: {
    width: 4,
    height: 20,
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    marginRight: spacing.sm,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
  },
  sectionCount: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textMuted,
    marginLeft: spacing.sm,
  },

  // Comments --------------------------------------------------------------
  commentsSection: {
    paddingTop: 0,
  },
  emptyComments: {
    alignItems: "center",
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  emptySubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  commentRow: {
    flexDirection: "row",
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.lg,
  },
  commentAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
    marginTop: 2,
  },
  commentAvatarLetter: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.primary,
  },
  commentBubble: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  commentHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  commentAuthor: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  commentBody: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  commentTime: {
    fontSize: 11,
    color: colors.textMuted,
  },

  // Comment input bar (fixed at bottom) -----------------------------------
  commentInputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    backgroundColor: colors.elevated,
  },
  commentInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    fontSize: 14,
    backgroundColor: colors.card,
    color: colors.text,
    marginRight: spacing.sm,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
});
