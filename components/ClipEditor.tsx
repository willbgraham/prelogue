import { useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";
import Slider from "@react-native-community/slider";
import { Feather } from "@expo/vector-icons";
import { colors, radius, spacing } from "@/lib/theme";

export type ClipEdit = { trimStart: number; trimEnd: number; volume: number; duration: number };

const clampVol = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Non-destructive per-clip review editor (mobile): preview the recorded take,
 * trim the start/end, set volume. Stored as metadata on the clip and applied at
 * playback — the file itself isn't re-encoded.
 */
export function ClipEditor({
  uri,
  edit,
  onChange,
}: {
  uri: string;
  edit: ClipEdit;
  onChange: (patch: Partial<ClipEdit>) => void;
}) {
  const ref = useRef<Video>(null);
  const [playing, setPlaying] = useState(false);
  const end = edit.trimEnd || edit.duration;

  function onLoad(status: AVPlaybackStatus) {
    if (status.isLoaded && status.durationMillis && (!edit.duration || !edit.trimEnd)) {
      const d = status.durationMillis / 1000;
      onChange({ duration: d, trimEnd: d });
    }
  }
  function onStatus(status: AVPlaybackStatus) {
    if (!status.isLoaded) return;
    if (playing && end && status.positionMillis / 1000 >= end) {
      ref.current?.pauseAsync().catch(() => {});
      setPlaying(false);
    } else if (status.didJustFinish) {
      setPlaying(false);
    }
  }
  async function preview() {
    const v = ref.current;
    if (!v) return;
    if (playing) {
      await v.pauseAsync().catch(() => {});
      setPlaying(false);
      return;
    }
    await v.setStatusAsync({ volume: clampVol(edit.volume) }).catch(() => {});
    await v.playFromPositionAsync(edit.trimStart * 1000).catch(() => {});
    setPlaying(true);
  }

  const max = edit.duration || 1;
  return (
    <View style={s.wrap}>
      <View style={s.videoWrap}>
        <Video
          ref={ref}
          source={{ uri }}
          style={s.video}
          resizeMode={ResizeMode.COVER}
          volume={clampVol(edit.volume)}
          onLoad={onLoad}
          onPlaybackStatusUpdate={onStatus}
        />
        <TouchableOpacity style={s.playBtn} onPress={preview} activeOpacity={0.85}>
          <Feather name={playing ? "pause" : "play"} size={13} color="#fff" />
          <Text style={s.playBtnText}>{playing ? "Stop" : "Preview"}</Text>
        </TouchableOpacity>
      </View>

      <View style={s.controls}>
        <Text style={s.label}>Trim start · {edit.trimStart.toFixed(1)}s</Text>
        <Slider
          minimumValue={0}
          maximumValue={max}
          value={edit.trimStart}
          step={0.1}
          minimumTrackTintColor={colors.primary}
          maximumTrackTintColor={colors.cardBorder}
          thumbTintColor={colors.primary}
          onValueChange={(v) => onChange({ trimStart: Math.min(v, end) })}
        />
        <Text style={s.label}>Trim end · {end.toFixed(1)}s</Text>
        <Slider
          minimumValue={0}
          maximumValue={max}
          value={end}
          step={0.1}
          minimumTrackTintColor={colors.primary}
          maximumTrackTintColor={colors.cardBorder}
          thumbTintColor={colors.primary}
          onValueChange={(v) => onChange({ trimEnd: Math.max(v, edit.trimStart) })}
        />
        <Text style={s.label}>Volume · {Math.round(edit.volume * 100)}%</Text>
        <Slider
          minimumValue={0}
          maximumValue={1}
          value={edit.volume}
          step={0.05}
          minimumTrackTintColor={colors.primary}
          maximumTrackTintColor={colors.cardBorder}
          thumbTintColor={colors.primary}
          onValueChange={(v) => onChange({ volume: v })}
        />
        <Text style={s.keep}>Keeps {Math.max(0, end - edit.trimStart).toFixed(1)}s of footage.</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    gap: spacing.md,
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  videoWrap: { width: 96, aspectRatio: 9 / 16, borderRadius: radius.md, overflow: "hidden", backgroundColor: "#000" },
  video: { flex: 1 },
  playBtn: {
    position: "absolute", bottom: 6, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(0,0,0,0.65)", paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full,
  },
  playBtnText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  controls: { flex: 1 },
  label: { color: colors.textMuted, fontSize: 11, fontWeight: "600", marginBottom: -2 },
  keep: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
});
