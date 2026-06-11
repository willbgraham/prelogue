import { useEffect, useState, useRef } from "react";
import { View, TouchableOpacity, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { Feather } from "@expo/vector-icons";
import { colors, radius, spacing } from "@/lib/theme";
import { getSignedUrl, getPublicUrl } from "@/lib/storage";

interface Props {
  /** Storage path for private bucket files */
  storagePath?: string;
  /** Direct URL for public files */
  url?: string;
  /** Which bucket (private needs signed URL) */
  bucket?: string;
  /** Aspect ratio (default 16:9) */
  aspectRatio?: number;
}

export function VideoPlayer({ storagePath, url, bucket = "submissions", aspectRatio = 16 / 9 }: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(url || null);
  const [loading, setLoading] = useState(!url);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (url) {
      setVideoUrl(url);
      setLoading(false);
      return;
    }
    if (!storagePath) return;

    async function loadUrl() {
      try {
        if (bucket === "assembled-reads" || bucket === "avatars") {
          setVideoUrl(getPublicUrl(bucket, storagePath!));
        } else {
          const signed = await getSignedUrl(bucket, storagePath!);
          setVideoUrl(signed);
        }
      } catch (err) {
        console.error("Failed to load video URL:", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    loadUrl();
  }, [storagePath, url, bucket]);

  const player = useVideoPlayer(videoUrl || "", (p) => {
    p.loop = false;
  });

  if (loading) {
    return (
      <View style={[s.container, { aspectRatio }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error || !videoUrl) {
    return (
      <View style={[s.container, { aspectRatio }]}>
        <Feather name="video-off" size={32} color={colors.textMuted} />
        <Text style={s.errorText}>Video unavailable</Text>
      </View>
    );
  }

  return (
    <View style={[s.wrapper, { aspectRatio }]}>
      <VideoView
        player={player}
        style={s.video}
        nativeControls
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    width: "100%",
    backgroundColor: colors.elevated,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  wrapper: {
    width: "100%",
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  video: {
    width: "100%",
    height: "100%",
  },
  errorText: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.sm,
  },
});
