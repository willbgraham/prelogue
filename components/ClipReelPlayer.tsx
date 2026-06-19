import { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { Feather } from "@expo/vector-icons";
import { colors, radius } from "@/lib/theme";

interface Props {
  /** Ready-to-play URIs (signed URLs or local file:// uris), in playback order. */
  uris: string[];
  aspectRatio?: number;
}

/**
 * Plays a set of short clips back-to-back as one continuous reel — the gap-free
 * playback of a per-line submission. Advances to the next clip when each one
 * finishes; tap to play/pause; replays from the start once the reel ends.
 */
export function ClipReelPlayer({ uris, aspectRatio = 9 / 16 }: Props) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const idxRef = useRef(0);

  const player = useVideoPlayer(uris[0] ?? "", (p) => {
    p.loop = false;
  });

  // Reset when the clip set changes.
  const key = uris.join("|");
  useEffect(() => {
    idxRef.current = 0;
    setIdx(0);
    setEnded(false);
    setPlaying(false);
    if (uris[0]) player.replace(uris[0]);
  }, [key]);

  // Chain to the next clip when the current one finishes.
  useEffect(() => {
    const sub = player.addListener("playToEnd", () => {
      const next = idxRef.current + 1;
      if (next < uris.length) {
        idxRef.current = next;
        setIdx(next);
        player.replace(uris[next]);
        player.play();
      } else {
        setPlaying(false);
        setEnded(true);
      }
    });
    return () => sub.remove();
  }, [player, uris.length]);

  function playAll() {
    if (ended || idxRef.current >= uris.length) {
      idxRef.current = 0;
      setIdx(0);
      setEnded(false);
      if (uris[0]) player.replace(uris[0]);
    }
    player.play();
    setPlaying(true);
  }

  function pause() {
    player.pause();
    setPlaying(false);
  }

  if (!uris.length) {
    return (
      <View style={[s.container, { aspectRatio }]}>
        <Feather name="video-off" size={28} color={colors.textMuted} />
        <Text style={s.muted}>No clips</Text>
      </View>
    );
  }

  return (
    <View style={[s.wrapper, { aspectRatio }]}>
      <VideoView player={player} style={s.video} nativeControls={false} contentFit="cover" />

      {playing ? (
        <>
          <TouchableOpacity style={s.tapLayer} activeOpacity={1} onPress={pause} />
          <View style={s.badge}>
            <Feather name="film" size={11} color="#fff" />
            <Text style={s.badgeText}>
              Line {idx + 1}/{uris.length}
            </Text>
          </View>
        </>
      ) : (
        <TouchableOpacity style={s.overlay} activeOpacity={0.85} onPress={playAll}>
          <View style={s.playCircle}>
            <Feather name={ended ? "rotate-ccw" : "play"} size={22} color="#fff" />
          </View>
          <Text style={s.overlayText}>
            {ended ? "Replay" : "Play"} · {uris.length} line{uris.length !== 1 ? "s" : ""}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrapper: { width: "100%", borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#000" },
  container: {
    width: "100%", backgroundColor: colors.elevated, alignItems: "center",
    justifyContent: "center", borderRadius: radius.lg, overflow: "hidden",
  },
  muted: { color: colors.textMuted, fontSize: 13, marginTop: 6 },
  video: { width: "100%", height: "100%" },
  tapLayer: { ...StyleSheet.absoluteFillObject },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.35)" },
  playCircle: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(188, 64, 38,0.92)",
    alignItems: "center", justifyContent: "center",
  },
  overlayText: { color: "#fff", fontWeight: "600", fontSize: 13, marginTop: 10 },
  badge: {
    position: "absolute", top: 10, right: 10, flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full,
  },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "600" },
});
