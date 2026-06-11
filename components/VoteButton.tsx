import { useState } from "react";
import { TouchableOpacity, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useRequireAuth } from "@/lib/useRequireAuth";
import { colors, radius, spacing } from "@/lib/theme";

interface Props {
  submissionId: string;
  initialVoteCount: number;
  initialHasVoted?: boolean;
}

export function VoteButton({ submissionId, initialVoteCount, initialHasVoted = false }: Props) {
  const [voteCount, setVoteCount] = useState(initialVoteCount);
  const [hasVoted, setHasVoted] = useState(initialHasVoted);
  const [busy, setBusy] = useState(false);
  const { requireAuth, isAuthed } = useRequireAuth();

  async function toggleVote() {
    if (!requireAuth("vote on this submission")) return;
    if (busy) return;
    setBusy(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      if (hasVoted) {
        // Remove vote
        await supabase
          .from("votes")
          .delete()
          .eq("user_id", session.user.id)
          .eq("submission_id", submissionId);
        setVoteCount((c) => Math.max(0, c - 1));
        setHasVoted(false);
      } else {
        // Add vote
        await supabase.from("votes").insert({
          user_id: session.user.id,
          submission_id: submissionId,
        });
        setVoteCount((c) => c + 1);
        setHasVoted(true);
      }
    } catch (err) {
      console.error("Vote error:", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <TouchableOpacity
      style={[s.container, hasVoted && s.voted]}
      onPress={toggleVote}
      disabled={busy}
      activeOpacity={0.7}
    >
      <Feather
        name="heart"
        size={14}
        color={hasVoted ? colors.red : colors.textMuted}
      />
      <Text style={[s.count, hasVoted && s.countVoted]}>{voteCount}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.elevated,
    gap: 4,
  },
  voted: {
    backgroundColor: colors.redMuted,
  },
  count: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textMuted,
  },
  countVoted: {
    color: colors.red,
  },
});
