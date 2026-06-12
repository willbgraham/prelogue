import { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from "expo-router";
import { Audio } from "expo-av";
import { useVideoPlayer, VideoView } from "expo-video";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { ErrorState } from "@/components/ErrorState";
import type { ParsedScript } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

interface Row {
  elementIndex: number;
  kind: "line" | "narrator";
  character?: string;
  text: string;
  sceneHeading?: string;
  castActor?: string | null;
}
interface LoadedCue {
  element_index: number;
  audio_path: string;
  signedUrl: string;
}
/** A cast actor's recorded clip for one line. */
interface ClipMedia {
  uri: string;
  actor: string;
}

type Medium = "idle" | "audio" | "video";

function buildRows(
  parsed: ParsedScript | undefined,
  castByChar: Record<string, string>
): Row[] {
  if (!parsed?.scenes) return [];
  const rows: Row[] = [];
  let gi = 0;
  for (const scene of parsed.scenes) {
    const heading = scene.heading?.trim();
    let headingPending = !!heading;
    for (const el of scene.elements ?? []) {
      const idx = gi++;
      const renderable = el.type === "dialogue" || el.type === "action";
      let rowHeading: string | undefined = undefined;
      if (headingPending && renderable) {
        rowHeading = heading;
        headingPending = false;
      }
      if (el.type === "dialogue") {
        const upper = (el.character_name || "").toUpperCase();
        rows.push({
          elementIndex: idx,
          kind: "line",
          character: el.character_name,
          text: el.text,
          sceneHeading: rowHeading,
          castActor: castByChar[upper] ?? null,
        });
      } else if (el.type === "action") {
        rows.push({ elementIndex: idx, kind: "narrator", text: el.text, sceneHeading: rowHeading });
      }
    }
  }
  return rows;
}

export default function TableReadPlayScreen() {
  const { scriptId } = useLocalSearchParams<{ scriptId: string }>();
  const router = useRouter();
  const listRef = useRef<FlatList<Row>>(null);

  const [title, setTitle] = useState("Table Read");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [medium, setMedium] = useState<Medium>("idle");
  const [clipCount, setClipCount] = useState(0);

  const manifestRef = useRef<Map<number, LoadedCue>>(new Map());
  const clipsRef = useRef<Map<number, ClipMedia>>(new Map());
  const soundRef = useRef<Audio.Sound | null>(null);
  const playingRef = useRef(false);
  const activeRef = useRef(0);
  const mediumRef = useRef<Medium>("idle");

  // One persistent video player drives the "stage" for cast actors' clips.
  const videoPlayer = useVideoPlayer("", (p) => {
    p.loop = false;
  });

  useEffect(() => {
    load();
    return () => {
      playingRef.current = false;
      soundRef.current?.unloadAsync().catch(() => {});
      try {
        videoPlayer.pause();
      } catch {}
    };
  }, [scriptId]);

  // Advance when a cast actor's clip finishes.
  useEffect(() => {
    const sub = videoPlayer.addListener("playToEnd", () => {
      if (playingRef.current && mediumRef.current === "video") {
        advance(activeRef.current);
      }
    });
    return () => sub.remove();
  }, [videoPlayer]);

  // Pause everything when the screen loses focus; the play button resumes.
  useFocusEffect(
    useCallback(() => {
      return () => {
        playingRef.current = false;
        setPlaying(false);
        soundRef.current?.pauseAsync().catch(() => {});
        try {
          videoPlayer.pause();
        } catch {}
      };
    }, [videoPlayer])
  );

  async function load() {
    try {
      const { data: script, error } = await supabase
        .from("scripts")
        .select("title, parsed_json")
        .eq("id", scriptId)
        .single();
      if (error) throw error;
      setTitle(script.title ?? "Table Read");

      // Writer's Choice submissions = the cast. Pull their per-line clips so we
      // can play the real actor's video where they have one.
      const { data: subs } = await supabase
        .from("submissions")
        .select(
          "clips, video_url, character:characters!submissions_character_id_fkey(name), actor:users!submissions_actor_id_fkey(display_name)"
        )
        .eq("script_id", scriptId)
        .eq("is_writers_choice", true);

      const castByChar: Record<string, string> = {};
      const clipPaths: { element_index: number; path: string; actor: string }[] = [];
      for (const sub of (subs as any[]) ?? []) {
        const name = sub.character?.name?.toUpperCase();
        const actorName = sub.actor?.display_name ?? "Actor";
        if (name) castByChar[name] = actorName;
        if (Array.isArray(sub.clips)) {
          for (const c of sub.clips) {
            if (c && typeof c.element_index === "number" && c.clip_url) {
              clipPaths.push({ element_index: c.element_index, path: c.clip_url, actor: actorName });
            }
          }
        }
      }

      // Sign the clip paths once for the session.
      const clipMap = new Map<number, ClipMedia>();
      const uniquePaths = [...new Set(clipPaths.map((c) => c.path))];
      if (uniquePaths.length) {
        const { data: signed } = await supabase.storage
          .from("submissions")
          .createSignedUrls(uniquePaths, 86400);
        const urlByPath = new Map<string, string>();
        uniquePaths.forEach((p, i) => urlByPath.set(p, signed?.[i]?.signedUrl ?? ""));
        for (const c of clipPaths) {
          const uri = urlByPath.get(c.path);
          if (uri) clipMap.set(c.element_index, { uri, actor: c.actor });
        }
      }
      clipsRef.current = clipMap;
      setClipCount(clipMap.size);

      setRows(buildRows(script.parsed_json as any, castByChar));
      setLoadError(false);
    } catch (err) {
      console.warn("Table read load error:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  const scrollTo = useCallback((index: number) => {
    if (index < 0) return;
    try {
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
    } catch {
      // onScrollToIndexFailed handles it
    }
  }, []);

  async function prepareAndPlay() {
    setPreparing(true);
    try {
      let manifestPath: string | null = null;
      for (let r = 0; r < 12; r++) {
        const { data, error } = await supabase.functions.invoke("generate-voice-cues", {
          body: { script_id: scriptId },
        });
        if (error) {
          Alert.alert("Couldn't prepare voices", String(error?.message ?? error));
          return;
        }
        manifestPath = data?.manifest_path ?? manifestPath;
        if (data?.done) break;
      }

      if (manifestPath) {
        const { data: signed } = await supabase.storage
          .from("scripts")
          .createSignedUrl(manifestPath, 3600);
        if (signed?.signedUrl) {
          const res = await fetch(signed.signedUrl);
          const cues: LoadedCue[] = await res.json();
          const uniquePaths = [...new Set(cues.map((c) => c.audio_path))];
          const { data: fresh } = await supabase.storage
            .from("scripts")
            .createSignedUrls(uniquePaths, 86400);
          const urlByPath = new Map<string, string>();
          uniquePaths.forEach((p, i) => urlByPath.set(p, fresh?.[i]?.signedUrl ?? ""));
          const map = new Map<number, LoadedCue>();
          for (const c of cues) {
            map.set(c.element_index, { ...c, signedUrl: urlByPath.get(c.audio_path) ?? "" });
          }
          manifestRef.current = map;
        }
      }

      setReady(true);
      startFrom(0);
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? String(e));
    } finally {
      setPreparing(false);
    }
  }

  async function unloadAudio() {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
  }

  function setActiveRow(pos: number) {
    activeRef.current = pos;
    setActive(pos);
  }
  function setMediumState(m: Medium) {
    mediumRef.current = m;
    setMedium(m);
  }

  async function playRow(rowPos: number) {
    const row = rows[rowPos];
    if (!row) {
      stop();
      return;
    }
    // Bail if we're paused or left the screen while an advance was queued —
    // otherwise this would restart media that nothing stops.
    if (!playingRef.current) return;

    setActiveRow(rowPos);
    setTimeout(() => scrollTo(rowPos), 60);

    const clip = clipsRef.current.get(row.elementIndex);
    if (clip?.uri) {
      // ---- Cast actor's recorded clip (video + their own audio) ----
      setMediumState("video");
      await unloadAudio();
      try {
        videoPlayer.replace(clip.uri);
        videoPlayer.play();
      } catch (err) {
        console.warn("Clip playback error:", err);
        if (playingRef.current) setTimeout(() => advance(rowPos), 200);
      }
      return; // the playToEnd listener advances
    }

    // ---- AI voice ----
    setMediumState("audio");
    try {
      videoPlayer.pause();
    } catch {}
    const cue = manifestRef.current.get(row.elementIndex);
    if (!cue?.signedUrl) {
      if (playingRef.current) setTimeout(() => advance(rowPos), 30);
      return;
    }
    try {
      await unloadAudio();
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync({ uri: cue.signedUrl }, { shouldPlay: true });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish && playingRef.current && mediumRef.current === "audio") {
          advance(rowPos);
        }
      });
    } catch (err) {
      console.warn("Playback error:", err);
      if (playingRef.current) setTimeout(() => advance(rowPos), 200);
    }
  }

  function advance(fromRow: number) {
    const next = fromRow + 1;
    if (next >= rows.length) {
      stop();
      setActiveRow(rows.length - 1);
      return;
    }
    playRow(next);
  }

  function startFrom(rowPos: number) {
    playingRef.current = true;
    setPlaying(true);
    playRow(rowPos);
  }

  async function pause() {
    playingRef.current = false;
    setPlaying(false);
    await soundRef.current?.pauseAsync().catch(() => {});
    try {
      videoPlayer.pause();
    } catch {}
  }

  function resume() {
    playingRef.current = true;
    setPlaying(true);
    if (mediumRef.current === "video") {
      try {
        videoPlayer.play();
        return;
      } catch {}
    }
    // Audio (or fallback): replay the current line cleanly.
    playRow(activeRef.current);
  }

  function stop() {
    playingRef.current = false;
    setPlaying(false);
  }

  function togglePlay() {
    if (playing) pause();
    else resume();
  }

  function restart() {
    setActiveRow(0);
    scrollTo(0);
    startFrom(0);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: "Table Read", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (loadError) {
    return (
      <View style={[s.center, { justifyContent: "center" }]}>
        <Stack.Screen options={{ title: "Table Read", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <ErrorState onRetry={() => { setLoading(true); load(); }} />
      </View>
    );
  }
  if (rows.length === 0) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: "Table Read", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <Feather name="file-text" size={40} color={colors.textMuted} />
        <Text style={s.emptyText}>This script hasn't been parsed yet.</Text>
      </View>
    );
  }

  const activeRow = rows[active];
  const activeClip = activeRow ? clipsRef.current.get(activeRow.elementIndex) : undefined;

  const renderRow = ({ item, index }: { item: Row; index: number }) => {
    const isActive = active === index;
    const isPast = index < active;
    const hasClip = clipsRef.current.has(item.elementIndex);
    return (
      <View>
        {item.sceneHeading ? <Text style={s.sceneHeading} numberOfLines={1}>{item.sceneHeading}</Text> : null}
        <TouchableOpacity
          style={[s.row, isActive && s.rowActive, isPast && s.rowPast]}
          activeOpacity={0.7}
          onPress={() => { setActiveRow(index); scrollTo(index); if (ready) startFrom(index); }}
        >
          {item.kind === "narrator" ? (
            <View style={[s.tag, s.tagNarrator]}>
              <Feather name="film" size={11} color={colors.textSecondary} />
            </View>
          ) : (
            <View style={[s.tag, s.tagChar]}>
              <Text style={s.tagCharText} numberOfLines={1}>{item.character}</Text>
            </View>
          )}
          <View style={s.lineContent}>
            <Text
              style={[s.lineText, item.kind === "narrator" && s.lineTextNarrator, isActive && s.lineTextActive, isPast && s.lineTextPast]}
              numberOfLines={4}
            >
              {item.text}
            </Text>
            {item.castActor ? (
              <View style={s.castBadge}>
                <Feather name={hasClip ? "video" : "user-check"} size={10} color={colors.green} />
                <Text style={s.castBadgeText}>{item.castActor}{hasClip ? "" : " (voice)"}</Text>
              </View>
            ) : null}
          </View>
          {isActive && playing ? (
            <Feather name={hasClip ? "video" : "volume-2"} size={14} color={colors.teal} />
          ) : null}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title, headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />

      {/* Stage — appears once playback starts. Shows the cast actor's clip, or a
          tasteful placeholder for AI-voiced lines / narration. */}
      {ready && (
        <View style={s.stage}>
          <VideoView player={videoPlayer} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
          {medium !== "video" && (
            <View style={s.stagePlaceholder}>
              {activeRow?.kind === "narrator" ? (
                <View style={s.stageAvatar}>
                  <Feather name="film" size={22} color={colors.textSecondary} />
                </View>
              ) : (
                <View style={s.stageAvatar}>
                  <Text style={s.stageInitial}>{activeRow?.character?.charAt(0) ?? "?"}</Text>
                </View>
              )}
              <Text style={s.stageName}>{activeRow?.kind === "narrator" ? "Narrator" : activeRow?.character}</Text>
              <View style={s.aiPill}>
                <Feather name="volume-2" size={11} color={colors.primary} />
                <Text style={s.aiPillText}>AI voice</Text>
              </View>
            </View>
          )}
          {medium === "video" && activeClip && (
            <View style={s.stageTag}>
              <Feather name="user-check" size={12} color="#fff" />
              <Text style={s.stageTagText}>{activeClip.actor}</Text>
            </View>
          )}
        </View>
      )}

      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(_i, i) => String(i)}
        renderItem={renderRow}
        extraData={`${active}-${playing}-${medium}-${clipCount}`}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={11}
        removeClippedSubviews
        onScrollToIndexFailed={(info) =>
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })
        }
      />

      {/* Transport bar */}
      <View style={s.transport}>
        {!ready ? (
          <TouchableOpacity style={s.playBtn} onPress={prepareAndPlay} disabled={preparing} activeOpacity={0.85}>
            {preparing ? (
              <>
                <ActivityIndicator color="#fff" />
                <Text style={s.playBtnText}>Preparing voices…</Text>
              </>
            ) : (
              <>
                <Feather name="play" size={18} color="#fff" />
                <Text style={s.playBtnText}>
                  Play Table Read{clipCount > 0 ? "  ·  with cast" : ""}
                </Text>
              </>
            )}
          </TouchableOpacity>
        ) : (
          <View style={s.transportRow}>
            <TouchableOpacity onPress={restart} style={s.transportSecondary} activeOpacity={0.8}>
              <Feather name="skip-back" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={togglePlay} style={s.transportPlay} activeOpacity={0.85}>
              <Feather name={playing ? "pause" : "play"} size={24} color="#fff" />
            </TouchableOpacity>
            <View style={s.transportSecondary}>
              <Text style={s.progressText}>{Math.min(active + 1, rows.length)}/{rows.length}</Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, paddingHorizontal: 32 },
  emptyText: { color: colors.textSecondary, fontSize: 15, marginTop: 12, textAlign: "center" },

  // Stage
  stage: {
    height: 270, backgroundColor: "#000", alignItems: "center", justifyContent: "center",
    borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
  },
  stagePlaceholder: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: colors.elevated, gap: 10 },
  stageAvatar: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primaryMuted,
    alignItems: "center", justifyContent: "center",
  },
  stageInitial: { color: colors.primary, fontSize: 30, fontWeight: "800" },
  stageName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  aiPill: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.primaryMuted, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.full },
  aiPillText: { color: colors.primary, fontSize: 12, fontWeight: "600" },
  stageTag: {
    position: "absolute", bottom: 12, left: 12, flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full,
  },
  stageTagText: { color: "#fff", fontSize: 12, fontWeight: "600" },

  sceneHeading: {
    color: colors.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 1,
    textTransform: "uppercase", marginTop: 12, marginBottom: 4, paddingHorizontal: 8,
  },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8, paddingHorizontal: 8, borderRadius: radius.md, marginBottom: 4 },
  rowActive: { backgroundColor: "rgba(0,206,201,0.12)", borderWidth: 1, borderColor: "rgba(0,206,201,0.3)" },
  rowPast: { opacity: 0.45 },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm, minWidth: 64, alignItems: "center", marginTop: 1 },
  tagChar: { backgroundColor: "rgba(108,92,231,0.18)" },
  tagCharText: { color: colors.primary, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  tagNarrator: { backgroundColor: colors.elevated, minWidth: 36 },
  lineContent: { flex: 1 },
  lineText: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
  lineTextNarrator: { fontStyle: "italic", color: colors.textMuted },
  lineTextActive: { color: colors.text, fontWeight: "500" },
  lineTextPast: { color: colors.textMuted },
  castBadge: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4, alignSelf: "flex-start", backgroundColor: colors.greenMuted, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  castBadgeText: { color: colors.green, fontSize: 10, fontWeight: "600" },

  transport: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: 36, backgroundColor: colors.elevated, borderTopWidth: 1, borderTopColor: colors.cardBorder },
  playBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16 },
  playBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  transportRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xxl },
  transportSecondary: { width: 56, alignItems: "center" },
  transportPlay: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  progressText: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
});
