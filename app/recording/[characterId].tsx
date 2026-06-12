import { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  FlatList,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Animated,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Audio } from "expo-av";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useBackgroundUpload } from "@/hooks/useBackgroundUpload";
import { VideoPlayer } from "@/components/VideoPlayer";
import { ErrorState } from "@/components/ErrorState";
import type { Character, ParsedScript } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ScriptRow {
  /** Global index across the flattened scenes[].elements[] — the manifest key. */
  elementIndex: number;
  kind: "actor" | "cue" | "narrator";
  character?: string;
  text: string;
  sceneHeading?: string;
}

interface LoadedCue {
  element_index: number;
  type: string;
  character: string | null;
  text: string;
  voice_id: string;
  audio_path: string;
  signedUrl: string;
}

/**
 * Build the teleprompter rows from the parsed script's ordered element stream.
 * The global index counts EVERY element so it stays aligned with the manifest
 * produced server-side (which numbers elements the same way). Actor rows are the
 * reader's own lines (no audio); cue rows are other characters' dialogue;
 * narrator rows are action / stage directions.
 */
function buildRows(parsed: ParsedScript | undefined, actorName: string): ScriptRow[] {
  if (!parsed?.scenes) return [];
  const actorUpper = actorName.toUpperCase();
  const rows: ScriptRow[] = [];
  let globalIdx = 0;

  for (const scene of parsed.scenes) {
    const heading = scene.heading?.trim();
    let headingPending = !!heading;
    for (const el of scene.elements ?? []) {
      const myIndex = globalIdx++;
      const isRenderable = el.type === "dialogue" || el.type === "action";
      let rowHeading: string | undefined = undefined;
      if (headingPending && isRenderable) {
        rowHeading = heading;
        headingPending = false;
      }

      if (el.type === "dialogue") {
        const isActor = (el.character_name || "").toUpperCase() === actorUpper;
        rows.push({
          elementIndex: myIndex,
          kind: isActor ? "actor" : "cue",
          character: el.character_name,
          text: el.text,
          sceneHeading: rowHeading,
        });
      } else if (el.type === "action") {
        rows.push({ elementIndex: myIndex, kind: "narrator", text: el.text, sceneHeading: rowHeading });
      }
      // character / parenthetical: index consumed, not rendered (silent).
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
export default function RecordingStudioScreen() {
  const { characterId } = useLocalSearchParams<{ characterId: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const cameraRef = useRef<CameraView>(null);
  const upload = useBackgroundUpload();
  const listRef = useRef<FlatList<ScriptRow>>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const [character, setCharacter] = useState<Character | null>(null);
  const [rows, setRows] = useState<ScriptRow[]>([]);
  const [activeLine, setActiveLine] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [recording, setRecording] = useState(false);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [facing, setFacing] = useState<"front" | "back">("front");

  // AI cues
  const [aiCueReady, setAiCueReady] = useState(false);
  const [generatingCues, setGeneratingCues] = useState(false);
  const [manifest, setManifest] = useState<Map<number, LoadedCue>>(new Map());
  const [playingCue, setPlayingCue] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const autoplayRef = useRef(false);

  // Takes
  const [existingTakes, setExistingTakes] = useState<any[]>([]);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);

  // Pulse animation for actor's turn
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    fetchCharacter();
    fetchTakes();
    return () => {
      soundRef.current?.unloadAsync();
    };
  }, [characterId]);

  useEffect(() => {
    if (rows[activeLine]?.kind === "actor" && recording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.6, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [activeLine, recording]);

  async function fetchCharacter() {
    try {
      const { data, error } = await supabase
        .from("characters")
        .select("*, script:scripts(id, title, parsed_json)")
        .eq("id", characterId)
        .single();

      if (error) throw error;
      if (data) {
        setCharacter(data as any);
        setRows(buildRows((data as any).script?.parsed_json, data.name));
      }
      setLoadError(false);
    } catch (err) {
      console.warn("Failed to load script:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  function retryLoad() {
    setLoading(true);
    setLoadError(false);
    fetchCharacter();
  }

  async function fetchTakes() {
    const { data } = await supabase
      .from("submissions")
      .select("id, take_number, is_preferred_take, created_at, video_url")
      .eq("actor_id", session?.user?.id)
      .eq("character_id", characterId)
      .order("take_number", { ascending: false });
    if (data) setExistingTakes(data);
  }

  // -------------------------------------------------------------------------
  // AI cue generation & playback
  // -------------------------------------------------------------------------
  async function generateAICues() {
    const scriptId = (character as any)?.script_id ?? (character as any)?.script?.id;
    if (!scriptId) return;

    setGeneratingCues(true);
    try {
      // The function is resumable (caps generation per call); drive it to
      // completion across a few rounds.
      let manifestPath: string | null = null;
      for (let round = 0; round < 10; round++) {
        const { data, error } = await supabase.functions.invoke("generate-voice-cues", {
          body: { script_id: scriptId },
        });
        if (error) {
          Alert.alert("AI Voices Error", String(error?.message ?? error));
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

          // Re-sign audio fresh (manifest stores paths; signed URLs expire 24h).
          const uniquePaths = [...new Set(cues.map((c) => c.audio_path))];
          const { data: freshSigned } = await supabase.storage
            .from("scripts")
            .createSignedUrls(uniquePaths, 86400);
          const urlByPath = new Map<string, string>();
          uniquePaths.forEach((p, i) => urlByPath.set(p, freshSigned?.[i]?.signedUrl ?? ""));

          const map = new Map<number, LoadedCue>();
          for (const c of cues) {
            map.set(c.element_index, { ...c, signedUrl: urlByPath.get(c.audio_path) ?? "" });
          }
          setManifest(map);
        }
      }

      setAiCueReady(true);
      Alert.alert(
        "AI Voices Ready",
        "Tap any other character or action line to hear it read aloud."
      );
    } catch (err: any) {
      Alert.alert("AI Voices Error", err?.message ?? String(err));
    } finally {
      setGeneratingCues(false);
    }
  }

  const scrollToRow = useCallback((index: number) => {
    if (index < 0) return;
    try {
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.35 });
    } catch {
      // ignore — onScrollToIndexFailed handles the fallback
    }
  }, []);

  async function stopPlayback() {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    setPlayingCue(false);
  }

  // Play the AI line at a row position. When autoplay is on, the playback-finish
  // callback chains into the next line.
  async function playRowAt(rowPos: number) {
    const row = rows[rowPos];
    if (!row || row.kind === "actor") return;
    setActiveLine(rowPos);
    setTimeout(() => scrollToRow(rowPos), 60);

    const cue = manifest.get(row.elementIndex);
    if (!cue?.signedUrl) {
      // Not generated yet — don't stall the autoplay chain.
      if (autoplayRef.current) setTimeout(() => autoAdvanceFrom(rowPos), 30);
      return;
    }
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      setPlayingCue(true);
      await Audio.setAudioModeAsync({ allowsRecordingIOS: recording, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync({ uri: cue.signedUrl }, { shouldPlay: true });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingCue(false);
          if (autoplayRef.current) autoAdvanceFrom(rowPos);
        }
      });
    } catch (err) {
      console.warn("Cue playback error:", err);
      setPlayingCue(false);
      Alert.alert("Playback failed", "Couldn't play this AI voice line.");
    }
  }

  // Autoplay chain: move to the next line and play it if it's an AI line, or
  // pause on the actor's line (they tap the ▼ control to continue).
  function autoAdvanceFrom(fromRow: number) {
    const next = fromRow + 1;
    if (next >= rows.length) {
      setActiveLine(rows.length - 1);
      return;
    }
    setActiveLine(next);
    setTimeout(() => scrollToRow(next), 60);
    if (rows[next].kind !== "actor") {
      playRowAt(next);
    }
    // actor line → pause and wait for tap-to-continue
  }

  function handleLineTap(rowPos: number) {
    setActiveLine(rowPos);
    setTimeout(() => scrollToRow(rowPos), 60);
    const row = rows[rowPos];
    if (row && row.kind !== "actor" && aiCueReady) {
      playRowAt(rowPos);
    }
  }

  // ▼ control. Also serves as "tap to continue": after the actor performs their
  // line, tapping resumes the autoplay chain on the next AI line.
  function advanceLine() {
    const next = Math.min(activeLine + 1, rows.length - 1);
    setActiveLine(next);
    setTimeout(() => scrollToRow(next), 60);
    const row = rows[next];
    if (autoplayRef.current && aiCueReady && row && row.kind !== "actor") {
      playRowAt(next);
    }
  }

  function toggleAutoplay() {
    const next = !autoplay;
    setAutoplay(next);
    autoplayRef.current = next;
    if (next) {
      const row = rows[activeLine];
      if (aiCueReady && row && row.kind !== "actor") playRowAt(activeLine);
    } else {
      stopPlayback();
    }
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------
  async function startRecording() {
    if (!cameraRef.current) return;
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    setRecording(true);
    setActiveLine(0);
    scrollToRow(0);
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: 300 });
      if (video) setVideoUri(video.uri);
    } catch (err) {
      console.error("Recording error:", err);
    }
    setRecording(false);
  }

  function stopRecording() {
    cameraRef.current?.stopRecording();
    soundRef.current?.stopAsync();
  }

  async function handleSubmit() {
    if (!videoUri || !session || !character) return;
    try {
      const { count } = await supabase
        .from("submissions")
        .select("*", { count: "exact", head: true })
        .eq("actor_id", session.user.id)
        .eq("character_id", characterId);

      const takeNumber = (count ?? 0) + 1;
      const storagePath = `${session.user.id}/${character.script_id}/${characterId}_take${takeNumber}.mp4`;

      const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
      if (!accessToken) throw new Error("Not authenticated");

      await new Promise<void>((resolve) => {
        upload.startUpload("submissions", storagePath, videoUri, accessToken, resolve);
      });

      const { data: inserted, error } = await supabase
        .from("submissions")
        .insert({
          actor_id: session.user.id,
          character_id: characterId,
          script_id: character.script_id,
          video_url: storagePath,
          take_number: takeNumber,
        })
        .select()
        .single();
      if (error) throw error;

      if (inserted) {
        await supabase
          .from("submissions")
          .update({ is_preferred_take: false })
          .eq("actor_id", session.user.id)
          .eq("character_id", characterId);
        await supabase
          .from("submissions")
          .update({ is_preferred_take: true })
          .eq("id", inserted.id);
      }

      await fetchTakes();
      Alert.alert("Submitted!", "Your audition has been uploaded.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (error: any) {
      Alert.alert("Upload Failed", error.message);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={[s.center, { justifyContent: "center" }]}>
        <ErrorState onRetry={retryLoad} />
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={s.center}>
        <Feather name="file-text" size={40} color={colors.textMuted} />
        <Text style={s.permTitle}>Script still processing</Text>
        <Text style={s.permSub}>
          This script hasn't finished parsing yet. Check back in a moment.
        </Text>
        <TouchableOpacity style={s.permBtn} onPress={retryLoad}>
          <Text style={s.permBtnText}>Reload</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!permission?.granted) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: "Permission", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <Feather name="camera" size={40} color={colors.textMuted} />
        <Text style={s.permTitle}>Camera Access Required</Text>
        <Text style={s.permSub}>We need camera and microphone access to record your read.</Text>
        <TouchableOpacity style={s.permBtn} onPress={requestPermission}>
          <Text style={s.permBtnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Preview mode after recording
  if (videoUri) {
    return (
      <>
        <Stack.Screen options={{ title: "Review Take", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <View style={s.reviewContainer}>
          <View style={s.reviewVideoWrap}>
            <VideoPlayer url={videoUri} aspectRatio={9 / 16} />
          </View>
          {upload.isUploading && (
            <View style={s.progressWrap}>
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${upload.progress * 100}%` }]} />
              </View>
              <Text style={s.progressText}>Uploading... {Math.round(upload.progress * 100)}%</Text>
            </View>
          )}
          {existingTakes.length > 0 && (
            <View style={s.takesSection}>
              <Text style={s.takesTitle}>Previous Takes ({existingTakes.length})</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.takesScroll}>
                {existingTakes.map((take) => (
                  <TouchableOpacity
                    key={take.id}
                    style={[s.takeCard, take.is_preferred_take && s.takePreferred]}
                    onPress={() => setSelectedTakeId(take.id === selectedTakeId ? null : take.id)}
                  >
                    <Text style={s.takeNum}>Take #{take.take_number}</Text>
                    {take.is_preferred_take && <Feather name="star" size={10} color={colors.yellow} />}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}
          <View style={s.reviewActions}>
            <TouchableOpacity style={s.reRecordBtn} onPress={() => setVideoUri(null)} disabled={upload.isUploading}>
              <Feather name="refresh-cw" size={16} color={colors.text} />
              <Text style={s.reRecordText}>Re-record</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.submitBtn} onPress={handleSubmit} disabled={upload.isUploading}>
              {upload.isUploading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Feather name="upload" size={16} color="#fff" />
                  <Text style={s.submitText}>Submit</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Recording view with full-script teleprompter
  // -------------------------------------------------------------------------
  const activeRow = rows[activeLine];

  const renderRow = ({ item, index }: { item: ScriptRow; index: number }) => {
    const isActive = activeLine === index;
    const isPast = index < activeLine;
    const isCuePlaying = isActive && playingCue && item.kind !== "actor";

    return (
      <View>
        {item.sceneHeading ? (
          <Text style={s.sceneHeading} numberOfLines={1}>
            {item.sceneHeading}
          </Text>
        ) : null}
        <TouchableOpacity
          style={[
            s.lineRow,
            isActive &&
              (item.kind === "actor"
                ? s.lineActiveActor
                : item.kind === "narrator"
                ? s.lineActiveNarrator
                : s.lineActiveCue),
            isPast && s.linePast,
          ]}
          onPress={() => handleLineTap(index)}
          activeOpacity={0.7}
        >
          {item.kind === "narrator" ? (
            <View style={[s.charLabel, s.charLabelNarrator]}>
              <Feather name="film" size={11} color={colors.textSecondary} />
            </View>
          ) : (
            <View style={[s.charLabel, item.kind === "actor" ? s.charLabelActor : s.charLabelOther]}>
              <Text
                style={[s.charLabelText, item.kind === "actor" ? s.charLabelTextActor : s.charLabelTextOther]}
                numberOfLines={1}
              >
                {item.character}
              </Text>
            </View>
          )}

          <View style={s.lineContent}>
            <Text
              style={[
                s.lineText,
                item.kind === "actor" && s.lineTextActor,
                item.kind === "narrator" && s.lineTextNarrator,
                isActive && s.lineTextActive,
                isPast && s.lineTextPast,
              ]}
              numberOfLines={4}
            >
              {item.text}
            </Text>
          </View>

          <View style={s.lineStatus}>
            {isCuePlaying ? (
              <Animated.View style={{ opacity: pulseAnim }}>
                <Feather name="volume-2" size={14} color={colors.teal} />
              </Animated.View>
            ) : item.kind === "actor" && isActive ? (
              <Animated.View style={{ opacity: pulseAnim }}>
                <Feather name="mic" size={14} color={colors.primary} />
              </Animated.View>
            ) : item.kind !== "actor" && aiCueReady ? (
              <Feather name="play" size={12} color={colors.textMuted} />
            ) : isPast ? (
              <Feather name="check" size={12} color={colors.green} />
            ) : null}
          </View>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: character?.name ?? "Read", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
      <View style={s.cameraContainer}>
        <CameraView ref={cameraRef} style={{ flex: 1 }} facing={facing} mode="video">
          {/* Teleprompter overlay */}
          <View style={s.teleprompter}>
            <View style={s.teleprompterHeader}>
              <View style={s.headerLeft}>
                <Text style={s.teleprompterTitle}>{recording ? "Recording" : "Script"}</Text>
                {recording && <View style={s.recDot} />}
              </View>
              {!aiCueReady ? (
                <TouchableOpacity style={s.aiCueBtn} onPress={generateAICues} disabled={generatingCues}>
                  {generatingCues ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <>
                      <Feather name="volume-2" size={12} color={colors.primary} />
                      <Text style={s.aiCueBtnText}>Load AI Voices</Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[s.aiCueBtn, autoplay && s.autoplayActive]}
                  onPress={toggleAutoplay}
                  activeOpacity={0.8}
                >
                  <Feather
                    name={autoplay ? "pause" : "play"}
                    size={12}
                    color={autoplay ? "#fff" : colors.primary}
                  />
                  <Text style={[s.aiCueBtnText, autoplay && { color: "#fff" }]}>Autoplay</Text>
                </TouchableOpacity>
              )}
            </View>

            <FlatList
              ref={listRef}
              data={rows}
              keyExtractor={(_item, i) => String(i)}
              style={s.teleprompterScroll}
              showsVerticalScrollIndicator={false}
              renderItem={renderRow}
              initialNumToRender={20}
              maxToRenderPerBatch={20}
              windowSize={11}
              removeClippedSubviews
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: true,
                });
              }}
              ListFooterComponent={<View style={{ height: 40 }} />}
            />

            <View style={s.hintBar}>
              {activeRow?.kind === "actor" ? (
                <Text style={s.hintText}>
                  <Text style={{ color: colors.primary }}>Your line</Text> — perform it, then tap{" "}
                  <Feather name="chevron-down" size={12} color={colors.textSecondary} /> to continue
                </Text>
              ) : activeRow?.kind === "narrator" ? (
                <Text style={s.hintText}>
                  {aiCueReady ? (
                    <>Tap to hear the <Text style={{ color: colors.textSecondary }}>narrator</Text></>
                  ) : (
                    "Stage direction — tap to advance"
                  )}
                </Text>
              ) : aiCueReady ? (
                <Text style={s.hintText}>
                  Tap to hear <Text style={{ color: colors.teal }}>AI read</Text> this line
                </Text>
              ) : (
                <Text style={s.hintText}>Tap to advance through the script</Text>
              )}
            </View>
          </View>

          {/* Controls */}
          <View style={s.controlsBar}>
            <View style={s.controlsRow}>
              <TouchableOpacity
                onPress={() => setFacing(facing === "front" ? "back" : "front")}
                style={s.controlBtn}
              >
                <Feather name="refresh-cw" size={20} color="#fff" />
              </TouchableOpacity>

              <TouchableOpacity
                style={[s.recordBtn, recording && s.recordBtnActive]}
                onPress={recording ? stopRecording : startRecording}
              >
                {recording ? <View style={s.stopIcon} /> : <View style={s.recordDot} />}
              </TouchableOpacity>

              <TouchableOpacity
                style={s.controlBtn}
                onPress={advanceLine}
                disabled={!recording && activeLine >= rows.length - 1}
              >
                <Feather name="chevron-down" size={24} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        </CameraView>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, paddingHorizontal: 32 },
  permTitle: { color: colors.text, fontSize: 20, fontWeight: "700", marginTop: 16, textAlign: "center" },
  permSub: { color: colors.textSecondary, fontSize: 14, textAlign: "center", marginTop: 8, lineHeight: 20 },
  permBtn: { backgroundColor: colors.primary, borderRadius: radius.xl, paddingHorizontal: 32, paddingVertical: 14, marginTop: 24 },
  permBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  // Review
  reviewContainer: { flex: 1, backgroundColor: colors.bg, padding: spacing.xl },
  reviewVideoWrap: { flex: 1, borderRadius: radius.xl, overflow: "hidden", marginBottom: spacing.lg },
  progressWrap: { marginBottom: spacing.lg },
  progressTrack: { height: 4, backgroundColor: colors.cardBorder, borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: colors.primary },
  progressText: { color: colors.textMuted, textAlign: "center", fontSize: 12, marginTop: 4 },
  reviewActions: { flexDirection: "row", gap: spacing.md },
  reRecordBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.card, borderRadius: radius.xl, paddingVertical: 16, gap: 8,
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  reRecordText: { color: colors.text, fontWeight: "600" },
  submitBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16, gap: 8,
  },
  submitText: { color: "#fff", fontWeight: "700" },

  // Takes
  takesSection: { paddingHorizontal: spacing.xl, marginBottom: spacing.lg },
  takesTitle: { color: colors.textSecondary, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  takesScroll: { gap: 8 },
  takeCard: {
    backgroundColor: colors.card, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1, borderColor: colors.cardBorder, flexDirection: "row", alignItems: "center", gap: 4,
  },
  takePreferred: { borderColor: colors.yellow },
  takeNum: { color: colors.text, fontSize: 13, fontWeight: "500" },

  // Camera
  cameraContainer: { flex: 1, backgroundColor: "#000" },

  // Teleprompter
  teleprompter: {
    position: "absolute", top: 0, left: 0, right: 0,
    backgroundColor: "rgba(0,0,0,0.85)", maxHeight: "60%",
    borderBottomLeftRadius: radius.xl, borderBottomRightRadius: radius.xl,
  },
  teleprompterHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  teleprompterTitle: { color: "#fff", fontWeight: "700", fontSize: 15 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  aiCueBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: colors.primaryMuted, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full,
  },
  aiCueBtnText: { color: colors.primary, fontSize: 12, fontWeight: "600" },
  autoplayActive: { backgroundColor: colors.primary },
  aiCueReady: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 6 },
  aiCueReadyText: { color: colors.green, fontSize: 12, fontWeight: "600" },

  teleprompterScroll: { paddingHorizontal: 12, paddingTop: 8 },

  // Scene heading divider
  sceneHeading: {
    color: colors.textMuted, fontSize: 10, fontWeight: "700",
    letterSpacing: 1, textTransform: "uppercase",
    marginTop: 10, marginBottom: 4, paddingHorizontal: 10,
  },

  // Dialogue lines
  lineRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: radius.md, marginBottom: 4, gap: 8,
  },
  lineActiveActor: { backgroundColor: "rgba(108,92,231,0.2)", borderWidth: 1, borderColor: "rgba(108,92,231,0.4)" },
  lineActiveCue: { backgroundColor: "rgba(0,206,201,0.12)", borderWidth: 1, borderColor: "rgba(0,206,201,0.3)" },
  lineActiveNarrator: { backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  linePast: { opacity: 0.4 },

  charLabel: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm,
    minWidth: 60, alignItems: "center",
  },
  charLabelActor: { backgroundColor: colors.primaryMuted },
  charLabelOther: { backgroundColor: "rgba(255,255,255,0.08)" },
  charLabelNarrator: { backgroundColor: "rgba(255,255,255,0.05)", minWidth: 36 },
  charLabelText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  charLabelTextActor: { color: colors.primary },
  charLabelTextOther: { color: colors.textSecondary },

  lineContent: { flex: 1 },
  lineText: { color: "rgba(255,255,255,0.55)", fontSize: 14, lineHeight: 19 },
  lineTextActor: { color: "rgba(255,255,255,0.7)" },
  lineTextNarrator: { color: "rgba(255,255,255,0.5)", fontStyle: "italic" },
  lineTextActive: { color: "#fff", fontWeight: "500" },
  lineTextPast: { color: "rgba(255,255,255,0.3)" },

  lineStatus: { width: 24, alignItems: "center" },

  // Hint bar
  hintBar: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)",
  },
  hintText: { color: colors.textMuted, fontSize: 12, textAlign: "center" },

  // Controls
  controlsBar: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    paddingBottom: 48, paddingTop: 16, alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  controlsRow: { flexDirection: "row", alignItems: "center", gap: 40 },
  controlBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  recordBtn: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 4, borderColor: "rgba(255,255,255,0.8)",
    alignItems: "center", justifyContent: "center",
  },
  recordBtnActive: { borderColor: colors.red },
  recordDot: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.red },
  stopIcon: { width: 28, height: 28, borderRadius: 4, backgroundColor: "#fff" },
});
