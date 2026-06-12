import { useEffect, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { VideoPlayer } from "./VideoPlayer";
import { ClipReelPlayer } from "./ClipReelPlayer";
import { colors, radius, spacing } from "@/lib/theme";
import type { Submission } from "@/lib/types";

interface Props {
  submission: Pick<Submission, "id" | "video_url" | "clips">;
  aspectRatio?: number;
}

/**
 * Plays a submission regardless of shape: a per-line submission (an array of
 * `clips`) plays as a gap-free reel; a legacy single-video submission plays
 * its `video_url`. Signs the private clip paths before handing them to the reel.
 */
export function SubmissionMedia({ submission, aspectRatio = 9 / 16 }: Props) {
  const clips = submission.clips ?? null;
  const hasClips = !!clips && clips.length > 0;
  const [uris, setUris] = useState<string[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!hasClips) return;
    let alive = true;
    setError(false);
    const paths = [...clips!]
      .sort((a, b) => a.element_index - b.element_index)
      .map((c) => c.clip_url);
    supabase.storage
      .from("submissions")
      .createSignedUrls(paths, 3600)
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err || !data) {
          setError(true);
          return;
        }
        setUris(data.map((d) => d.signedUrl).filter(Boolean) as string[]);
      });
    return () => {
      alive = false;
    };
  }, [submission.id, hasClips]);

  if (hasClips) {
    if (error) {
      return (
        <View style={[s.box, { aspectRatio }]}>
          <Feather name="video-off" size={28} color={colors.textMuted} />
          <Text style={s.muted}>Clips unavailable</Text>
        </View>
      );
    }
    if (!uris) {
      return (
        <View style={[s.box, { aspectRatio }]}>
          <ActivityIndicator color={colors.primary} />
        </View>
      );
    }
    return <ClipReelPlayer uris={uris} aspectRatio={aspectRatio} />;
  }

  if (submission.video_url) {
    return <VideoPlayer storagePath={submission.video_url} bucket="submissions" aspectRatio={aspectRatio} />;
  }

  return (
    <View style={[s.box, { aspectRatio }]}>
      <Feather name="video-off" size={28} color={colors.textMuted} />
      <Text style={s.muted}>No recording</Text>
    </View>
  );
}

const s = StyleSheet.create({
  box: {
    width: "100%", backgroundColor: colors.elevated, alignItems: "center",
    justifyContent: "center", borderRadius: radius.lg, overflow: "hidden",
  },
  muted: { color: colors.textMuted, fontSize: 13, marginTop: spacing.sm },
});
