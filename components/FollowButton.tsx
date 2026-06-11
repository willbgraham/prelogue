import { useState, useEffect } from "react";
import { TouchableOpacity, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useRequireAuth } from "@/lib/useRequireAuth";
import { colors, radius, spacing } from "@/lib/theme";

interface Props {
  userId: string;
}

export function FollowButton({ userId }: Props) {
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const { requireAuth, isAuthed } = useRequireAuth();

  useEffect(() => {
    checkFollowStatus();
  }, [userId]);

  async function checkFollowStatus() {
    if (!isAuthed) {
      setLoading(false);
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || session.user.id === userId) {
      setLoading(false);
      return;
    }
    const { count } = await supabase
      .from("follows")
      .select("*", { count: "exact", head: true })
      .eq("follower_id", session.user.id)
      .eq("following_id", userId);
    setFollowing((count ?? 0) > 0);
    setLoading(false);
  }

  async function toggleFollow() {
    if (!requireAuth("follow this user")) return;
    if (busy) return;
    setBusy(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      if (following) {
        await supabase
          .from("follows")
          .delete()
          .eq("follower_id", session.user.id)
          .eq("following_id", userId);
        setFollowing(false);
      } else {
        await supabase.from("follows").insert({
          follower_id: session.user.id,
          following_id: userId,
        });
        setFollowing(true);
      }
    } catch (err) {
      console.error("Follow error:", err);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  return (
    <TouchableOpacity
      style={[s.btn, following && s.btnFollowing]}
      onPress={toggleFollow}
      disabled={busy}
      activeOpacity={0.8}
    >
      <Feather
        name={following ? "user-check" : "user-plus"}
        size={14}
        color={following ? colors.primary : "#fff"}
      />
      <Text style={[s.text, following && s.textFollowing]}>
        {following ? "Following" : "Follow"}
      </Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: radius.full,
    gap: 6,
  },
  btnFollowing: {
    backgroundColor: colors.primaryMuted,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  text: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },
  textFollowing: {
    color: colors.primary,
  },
});
