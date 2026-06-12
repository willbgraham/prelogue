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
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Audio } from "expo-av";
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

  const manifestRef = useRef<Map<number, LoadedCue>>(new Map());
  const soundRef = useRef<Audio.Sound | null>(null);
  const playingRef = useRef(false);

  useEffect(() => {
    load();
    return () => {
      playingRef.current = false;
      soundRef.current?.unloadAsync().catch(() => {});
    };
  }, [scriptId]);

  async function load() {
    try {
      const { data: script, error } = await supabase
        .from("scripts")
        .select("title, parsed_json")
        .eq("id", scriptId)
        .single();
      if (error) throw error;
      setTitle(script.title ?? "Table Read");

      // Which characters are cast by a real actor (Writer's Choice)?
      const { data: subs } = await supabase
        .from("submissions")
        .select(
          "character:characters!submissions_character_id_fkey(name), actor:users!submissions_actor_id_fkey(display_name)"
        )
        .eq("script_id", scriptId)
        .eq("is_writers_choice", true);
      const castByChar: Record<string, string> = {};
      for (const sub of (subs as any[]) ?? []) {
        const name = sub.character?.name?.toUpperCase();
        if (name) castByChar[name] = sub.actor?.display_name ?? "Actor";
      }

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

  async function playRow(rowPos: number) {
    const row = rows[rowPos];
    if (!row) {
      stop();
      return;
    }
    setActive(rowPos);
    setTimeout(() => scrollTo(rowPos), 60);

    const cue = manifestRef.current.get(row.elementIndex);
    if (!cue?.signedUrl) {
      // No audio for this line yet — skip ahead so playback doesn't stall.
      if (playingRef.current) setTimeout(() => advance(rowPos), 30);
      return;
    }
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync({ uri: cue.signedUrl }, { shouldPlay: true });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish && playingRef.current) {
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
      setActive(rows.length - 1);
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
  }

  async function resume() {
    playingRef.current = true;
    setPlaying(true);
    const status = await soundRef.current?.getStatusAsync().catch(() => null);
    if (status && (status as any).isLoaded && !(status as any).didJustFinish) {
      await soundRef.current?.playAsync().catch(() => {});
    } else {
      playRow(active);
    }
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
    setActive(0);
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

  const renderRow = ({ item, index }: { item: Row; index: number }) => {
    const isActive = active === index;
    const isPast = index < active;
    return (
      <View>
        {item.sceneHeading ? <Text style={s.sceneHeading} numberOfLines={1}>{item.sceneHeading}</Text> : null}
        <TouchableOpacity
          style={[s.row, isActive && s.rowActive, isPast && s.rowPast]}
          activeOpacity={0.7}
          onPress={() => { setActive(index); scrollTo(index); if (ready) startFrom(index); }}
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
                <Feather name="user-check" size={10} color={colors.green} />
                <Text style={s.castBadgeText}>{item.castActor}</Text>
              </View>
            ) : null}
          </View>
          {isActive && playing ? <Feather name="volume-2" size={14} color={colors.teal} /> : null}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title, headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />

      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(_i, i) => String(i)}
        renderItem={renderRow}
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
                <Text style={s.playBtnText}>Play Table Read</Text>
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
