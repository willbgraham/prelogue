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
import { uploadVideoResumable } from "@/lib/storage";
import { ClipReelPlayer } from "@/components/ClipReelPlayer";
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

/** A recorded clip for one of the actor's lines, keyed by element index. */
interface ClipTake {
  elementIndex: number;
  uri: string;
  character?: string;
  text: string;
}

type Mode = "idle" | "recording" | "review";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Upload one clip via the resumable uploader, wrapped as a promise. */
function uploadClipAsync(
  path: string,
  uri: string,
  token: string,
  onProgress: (p: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    uploadVideoResumable(
      "submissions",
      path,
      uri,
      token,
      onProgress,
      () => resolve(),
      (e) => reject(e)
    );
  });
}

/**
 * Build the teleprompter rows from the parsed script's ordered element stream.
 * The global index counts EVERY element so it stays aligned with the manifest
 * produced server-side. Actor rows are the reader's own lines; cue rows are
 * other characters' dialogue; narrator rows are action / stage directions.
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
  const listRef = useRef<FlatList<ScriptRow>>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const [character, setCharacter] = useState<Character | null>(null);
  const [rows, setRows] = useState<ScriptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [facing, setFacing] = useState<"front" | "back">("front");

  // Session state (mirrored into refs so playback/record callbacks read fresh).
  const [mode, setMode] = useState<Mode>("idle");
  const [activeLine, setActiveLine] = useState(0);
  const [clipRecording, setClipRecording] = useState(false);
  const [clipCount, setClipCount] = useState(0);

  const modeRef = useRef<Mode>("idle");
  const posRef = useRef(0);
  const singleRef = useRef<number | null>(null);
  const clipRecordingRef = useRef(false);
  const recordPromiseRef = useRef<Promise<any> | null>(null);
  const clipsRef = useRef<Map<number, ClipTake>>(new Map());

  // AI scene-partner cues
  const [aiCueReady, setAiCueReady] = useState(false);
  const [generatingCues, setGeneratingCues] = useState(false);
  const [manifest, setManifest] = useState<Map<number, LoadedCue>>(new Map());
  const [playingCue, setPlayingCue] = useState(false);
  const aiReadyRef = useRef(false);
  const manifestRef = useRef<Map<number, LoadedCue>>(new Map());
  const soundRef = useRef<Audio.Sound | null>(null);

  // Upload
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLabel, setUploadLabel] = useState("");
  const [existingTakeCount, setExistingTakeCount] = useState(0);

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    fetchCharacter();
    fetchTakeCount();
    return () => {
      soundRef.current?.unloadAsync();
    };
  }, [characterId]);

  useEffect(() => {
    if (clipRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.5, duration: 700, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [clipRecording]);

  // -------------------------------------------------------------------------
  // Mirrored-state setters
  // -------------------------------------------------------------------------
  function setModeR(m: Mode) {
    modeRef.current = m;
    setMode(m);
  }
  function goPos(p: number) {
    posRef.current = p;
    setActiveLine(p);
  }
  function setClipRecordingState(b: boolean) {
    clipRecordingRef.current = b;
    setClipRecording(b);
  }
  function setClip(t: ClipTake) {
    clipsRef.current.set(t.elementIndex, t);
    setClipCount(clipsRef.current.size);
  }
  function clearClips() {
    clipsRef.current = new Map();
    setClipCount(0);
  }

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

  async function fetchTakeCount() {
    const { count } = await supabase
      .from("submissions")
      .select("*", { count: "exact", head: true })
      .eq("actor_id", session?.user?.id)
      .eq("character_id", characterId);
    setExistingTakeCount(count ?? 0);
  }

  // -------------------------------------------------------------------------
  // AI scene-partner generation & playback
  // -------------------------------------------------------------------------
  async function generateAICues() {
    const scriptId = (character as any)?.script_id ?? (character as any)?.script?.id;
    if (!scriptId) return;

    setGeneratingCues(true);
    try {
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
          manifestRef.current = map;
        }
      }

      setAiCueReady(true);
      aiReadyRef.current = true;
      Alert.alert(
        "Scene partner ready",
        "The AI will read the other characters and narration between your lines."
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
      // onScrollToIndexFailed handles the fallback
    }
  }, []);

  async function stopPlayback() {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    setPlayingCue(false);
  }

  /** Play the AI line at `pos`. In a session (chain), advance when it finishes. */
  async function playCueAt(pos: number, chain: boolean) {
    const row = rows[pos];
    if (!row || row.kind === "actor") return;
    const cue = manifestRef.current.get(row.elementIndex);
    if (!cue?.signedUrl) {
      if (chain) setTimeout(() => advanceFrom(pos), 120);
      return;
    }
    try {
      await stopPlayback();
      setPlayingCue(true);
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync({ uri: cue.signedUrl }, { shouldPlay: true });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingCue(false);
          if (chain && modeRef.current === "recording" && posRef.current === pos) {
            advanceFrom(pos);
          }
        }
      });
    } catch (err) {
      console.warn("Cue playback error:", err);
      setPlayingCue(false);
      if (chain) setTimeout(() => advanceFrom(pos), 120);
    }
  }

  function advanceFrom(pos: number) {
    goToRow(pos + 1);
  }

  // -------------------------------------------------------------------------
  // Session engine
  // -------------------------------------------------------------------------
  /** Move to a row and act on it: record actor lines, play AI for others. */
  function goToRow(pos: number) {
    if (pos >= rows.length) {
      // Reached the end — wrap up the session.
      stopPlayback();
      singleRef.current = null;
      setModeR("review");
      return;
    }
    goPos(pos);
    setTimeout(() => scrollToRow(pos), 50);

    if (modeRef.current !== "recording") return;
    const row = rows[pos];
    if (row.kind === "actor") {
      beginClip(pos);
    } else if (aiReadyRef.current && manifestRef.current.get(row.elementIndex)?.signedUrl) {
      // AI scene partner reads this line, then auto-advances.
      playCueAt(pos, true);
    }
    // Otherwise (no AI for this cue): wait for the actor to tap Next.
  }

  async function beginClip(pos: number) {
    const row = rows[pos];
    if (!row || row.kind !== "actor") return;
    await stopPlayback();
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    } catch {}
    if (!cameraRef.current) return;
    try {
      setClipRecordingState(true);
      // recordAsync resolves only once stopRecording() is called.
      recordPromiseRef.current = cameraRef.current.recordAsync({ maxDuration: 120 });
    } catch (err) {
      console.warn("recordAsync failed:", err);
      setClipRecordingState(false);
    }
  }

  /** Stop the current clip and resolve its uri (or null on failure). */
  async function endClip(): Promise<string | null> {
    const promise = recordPromiseRef.current;
    try {
      cameraRef.current?.stopRecording();
    } catch {}
    let uri: string | null = null;
    try {
      const v = await promise;
      uri = (v as any)?.uri ?? null;
    } catch {}
    recordPromiseRef.current = null;
    setClipRecordingState(false);
    return uri;
  }

  /** "Done" — save the current line's clip and continue. */
  async function finishClip() {
    if (!clipRecordingRef.current) return;
    const pos = posRef.current;
    const row = rows[pos];
    const uri = await endClip();
    if (uri && row?.kind === "actor") {
      setClip({ elementIndex: row.elementIndex, uri, character: row.character, text: row.text });
    }
    if (singleRef.current != null) {
      singleRef.current = null;
      finishSession();
      return;
    }
    await sleep(350); // let the camera re-arm before the next clip
    goToRow(pos + 1);
  }

  /** Discard the current clip and re-record this same line. */
  async function retakeLine() {
    const pos = posRef.current;
    if (clipRecordingRef.current) {
      await endClip();
      await sleep(350);
    }
    beginClip(pos);
  }

  /** Skip the current line (discard any in-progress clip) and advance. */
  async function skipLine() {
    const pos = posRef.current;
    const wasRecording = clipRecordingRef.current;
    if (wasRecording) await endClip();
    if (singleRef.current != null) {
      singleRef.current = null;
      finishSession();
      return;
    }
    if (wasRecording) await sleep(350);
    goToRow(pos + 1);
  }

  async function startSession() {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return;
    }
    clearClips();
    singleRef.current = null;
    setModeR("recording");
    goToRow(0);
  }

  /** Finish the whole session (saving an in-progress clip) → review. */
  async function finishSession() {
    if (clipRecordingRef.current) {
      const pos = posRef.current;
      const row = rows[pos];
      const uri = await endClip();
      if (uri && row?.kind === "actor") {
        setClip({ elementIndex: row.elementIndex, uri, character: row.character, text: row.text });
      }
    }
    await stopPlayback();
    singleRef.current = null;
    setModeR("review");
  }

  /** Re-record a single line from the review screen. */
  async function reRecordLine(pos: number) {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return;
    }
    singleRef.current = pos;
    setModeR("recording");
    goPos(pos);
    setTimeout(() => scrollToRow(pos), 50);
    beginClip(pos);
  }

  function handleLineTap(pos: number) {
    if (modeRef.current === "recording") return; // session drives position
    goPos(pos);
    setTimeout(() => scrollToRow(pos), 50);
    const row = rows[pos];
    if (row && row.kind !== "actor" && aiReadyRef.current) {
      playCueAt(pos, false);
    }
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------
  async function handleSubmit() {
    const takes = [...clipsRef.current.values()].sort((a, b) => a.elementIndex - b.elementIndex);
    if (!takes.length || !session || !character) return;
    try {
      setUploading(true);
      const { count } = await supabase
        .from("submissions")
        .select("*", { count: "exact", head: true })
        .eq("actor_id", session.user.id)
        .eq("character_id", characterId);
      const takeNumber = (count ?? 0) + 1;

      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) throw new Error("Not authenticated");

      const clips: { element_index: number; clip_url: string }[] = [];
      for (let i = 0; i < takes.length; i++) {
        const t = takes[i];
        setUploadLabel(`Uploading line ${i + 1} of ${takes.length}…`);
        setUploadProgress(0);
        const idxStr = String(t.elementIndex).padStart(5, "0");
        const path = `${session.user.id}/${character.script_id}/${characterId}/t${takeNumber}/e${idxStr}.mp4`;
        await uploadClipAsync(path, t.uri, token, (p) => setUploadProgress(p));
        clips.push({ element_index: t.elementIndex, clip_url: path });
      }

      setUploadLabel("Saving…");
      const { data: inserted, error } = await supabase
        .from("submissions")
        .insert({
          actor_id: session.user.id,
          character_id: characterId,
          script_id: character.script_id,
          video_url: null,
          clips,
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

      await fetchTakeCount();
      Alert.alert(
        "Submitted!",
        `Your read (${takes.length} line${takes.length !== 1 ? "s" : ""}) has been uploaded.`,
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (error: any) {
      Alert.alert("Upload Failed", error?.message ?? String(error));
    } finally {
      setUploading(false);
      setUploadLabel("");
    }
  }

  // -------------------------------------------------------------------------
  // Render — gates
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
        <Text style={s.permSub}>This script hasn't finished parsing yet. Check back in a moment.</Text>
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

  // -------------------------------------------------------------------------
  // Render — review
  // -------------------------------------------------------------------------
  const actorRows = rows.filter((r) => r.kind === "actor");
  const recordedCount = clipCount;

  if (mode === "review") {
    const localUris = [...clipsRef.current.values()]
      .sort((a, b) => a.elementIndex - b.elementIndex)
      .map((t) => t.uri);

    return (
      <>
        <Stack.Screen options={{ title: "Review Read", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <View style={s.reviewContainer}>
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
            <Text style={s.reviewSummary}>
              {recordedCount} of {actorRows.length} line{actorRows.length !== 1 ? "s" : ""} recorded
            </Text>

            {localUris.length > 0 ? (
              <View style={s.reviewReelWrap}>
                <ClipReelPlayer uris={localUris} aspectRatio={9 / 16} />
              </View>
            ) : (
              <View style={s.reviewEmpty}>
                <Feather name="video-off" size={32} color={colors.textMuted} />
                <Text style={s.reviewEmptyText}>No lines recorded yet.</Text>
              </View>
            )}

            <Text style={s.reviewListTitle}>Your lines</Text>
            {actorRows.map((row) => {
              const has = clipsRef.current.has(row.elementIndex);
              return (
                <View key={row.elementIndex} style={s.reviewLineRow}>
                  <View style={[s.reviewLineDot, has ? s.reviewLineDotDone : s.reviewLineDotMissing]}>
                    <Feather name={has ? "check" : "circle"} size={12} color={has ? colors.green : colors.textMuted} />
                  </View>
                  <Text style={s.reviewLineText} numberOfLines={2}>
                    {row.text}
                  </Text>
                  <TouchableOpacity style={s.reRecBtn} onPress={() => reRecordLine(rows.indexOf(row))}>
                    <Feather name="rotate-ccw" size={13} color={colors.primary} />
                    <Text style={s.reRecText}>{has ? "Redo" : "Record"}</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>

          {uploading && (
            <View style={s.progressWrap}>
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${Math.round(uploadProgress * 100)}%` }]} />
              </View>
              <Text style={s.progressText}>{uploadLabel}</Text>
            </View>
          )}

          <View style={s.reviewActions}>
            <TouchableOpacity style={s.reRecordAllBtn} onPress={startSession} disabled={uploading}>
              <Feather name="refresh-cw" size={16} color={colors.text} />
              <Text style={s.reRecordAllText}>Re-record all</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.submitBtn, (uploading || recordedCount === 0) && { opacity: 0.5 }]}
              onPress={handleSubmit}
              disabled={uploading || recordedCount === 0}
            >
              {uploading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Feather name="upload" size={16} color="#fff" />
                  <Text style={s.submitText}>Submit read</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Render — camera + teleprompter (idle + recording)
  // -------------------------------------------------------------------------
  const activeRow = rows[activeLine];
  const isActorRow = activeRow?.kind === "actor";
  const hasClipHere = !!activeRow && clipsRef.current.has(activeRow.elementIndex);
  const isRecordingSession = mode === "recording";

  const renderRow = ({ item, index }: { item: ScriptRow; index: number }) => {
    const isActive = activeLine === index;
    const isPast = index < activeLine;
    const isCuePlaying = isActive && playingCue && item.kind !== "actor";
    const recorded = clipsRef.current.has(item.elementIndex);

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
            ) : item.kind === "actor" && isActive && clipRecording ? (
              <Animated.View style={{ opacity: pulseAnim }}>
                <Feather name="mic" size={14} color={colors.red} />
              </Animated.View>
            ) : item.kind === "actor" && recorded ? (
              <Feather name="check-circle" size={13} color={colors.green} />
            ) : item.kind !== "actor" && aiCueReady ? (
              <Feather name="play" size={12} color={colors.textMuted} />
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
                <Text style={s.teleprompterTitle}>{isRecordingSession ? "Recording" : "Your lines"}</Text>
                {clipRecording && <View style={s.recDot} />}
                {clipCount > 0 && (
                  <View style={s.clipCountPill}>
                    <Feather name="check" size={10} color={colors.green} />
                    <Text style={s.clipCountText}>{clipCount}</Text>
                  </View>
                )}
              </View>

              {isRecordingSession ? (
                <TouchableOpacity style={s.finishBtn} onPress={finishSession} activeOpacity={0.85}>
                  <Text style={s.finishBtnText}>Finish</Text>
                  <Feather name="check" size={13} color="#fff" />
                </TouchableOpacity>
              ) : !aiCueReady ? (
                <TouchableOpacity style={s.aiCueBtn} onPress={generateAICues} disabled={generatingCues}>
                  {generatingCues ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <>
                      <Feather name="volume-2" size={12} color={colors.primary} />
                      <Text style={s.aiCueBtnText}>Scene partner</Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : (
                <View style={s.aiReadyChip}>
                  <Feather name="check-circle" size={12} color={colors.green} />
                  <Text style={s.aiReadyText}>Partner ready</Text>
                </View>
              )}
            </View>

            <FlatList
              ref={listRef}
              data={rows}
              keyExtractor={(_item, i) => String(i)}
              style={s.teleprompterScroll}
              showsVerticalScrollIndicator={false}
              renderItem={renderRow}
              extraData={`${activeLine}-${clipCount}-${clipRecording}-${playingCue}`}
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
              {!isRecordingSession ? (
                <Text style={s.hintText}>
                  Tap <Text style={{ color: colors.red }}>Record</Text> to read your lines —
                  {aiCueReady ? " the partner feeds you cues" : " load a scene partner above to hear cues"}
                </Text>
              ) : isActorRow ? (
                <Text style={s.hintText}>
                  <Text style={{ color: colors.red }}>Your line</Text> — perform it, then tap{" "}
                  <Text style={{ color: colors.text }}>Done</Text>
                </Text>
              ) : activeRow?.kind === "narrator" ? (
                <Text style={s.hintText}>
                  {playingCue ? "Narrator reading…" : "Stage direction — tap Next to continue"}
                </Text>
              ) : (
                <Text style={s.hintText}>
                  {playingCue ? (
                    <>
                      <Text style={{ color: colors.teal }}>{activeRow?.character}</Text> reading…
                    </>
                  ) : (
                    "Other character — tap Next to continue"
                  )}
                </Text>
              )}
            </View>
          </View>

          {/* Controls */}
          <View style={s.controlsBar}>
            <View style={s.controlsRow}>
              {/* Left */}
              {isRecordingSession && isActorRow ? (
                <TouchableOpacity
                  style={s.controlBtn}
                  onPress={retakeLine}
                  disabled={!hasClipHere && !clipRecording}
                >
                  <Feather
                    name="rotate-ccw"
                    size={22}
                    color={!hasClipHere && !clipRecording ? colors.textMuted : "#fff"}
                  />
                  <Text style={s.controlLabel}>Retake</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={s.controlBtn}
                  onPress={() => setFacing(facing === "front" ? "back" : "front")}
                  disabled={clipRecording}
                >
                  <Feather name="refresh-cw" size={20} color={clipRecording ? colors.textMuted : "#fff"} />
                  <Text style={s.controlLabel}>Flip</Text>
                </TouchableOpacity>
              )}

              {/* Center — primary action */}
              {!isRecordingSession ? (
                <TouchableOpacity style={s.recordBtn} onPress={startSession}>
                  <View style={s.recordDot} />
                </TouchableOpacity>
              ) : isActorRow ? (
                clipRecording ? (
                  <TouchableOpacity style={[s.recordBtn, s.recordBtnActive]} onPress={finishClip}>
                    <View style={s.stopIcon} />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={s.recordBtn} onPress={() => beginClip(activeLine)}>
                    <View style={s.recordDot} />
                  </TouchableOpacity>
                )
              ) : (
                <TouchableOpacity style={s.nextBtn} onPress={skipLine}>
                  <Feather name="chevron-down" size={28} color="#fff" />
                  <Text style={s.nextBtnLabel}>Next</Text>
                </TouchableOpacity>
              )}

              {/* Right */}
              {isRecordingSession && isActorRow ? (
                <TouchableOpacity style={s.controlBtn} onPress={skipLine}>
                  <Feather name="skip-forward" size={20} color="#fff" />
                  <Text style={s.controlLabel}>Skip</Text>
                </TouchableOpacity>
              ) : (
                <View style={s.controlBtn} />
              )}
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
  reviewSummary: { color: colors.text, fontSize: 16, fontWeight: "700", marginBottom: spacing.md },
  reviewReelWrap: { width: "60%", alignSelf: "center", marginBottom: spacing.lg },
  reviewEmpty: { alignItems: "center", paddingVertical: spacing.xxl },
  reviewEmptyText: { color: colors.textMuted, marginTop: 8 },
  reviewListTitle: { color: colors.textSecondary, fontSize: 13, fontWeight: "600", marginBottom: spacing.sm, marginTop: spacing.sm },
  reviewLineRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, marginBottom: 8,
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  reviewLineDot: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  reviewLineDotDone: { backgroundColor: colors.greenMuted },
  reviewLineDotMissing: { backgroundColor: colors.elevated },
  reviewLineText: { flex: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  reRecBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.primaryMuted, borderRadius: radius.full },
  reRecText: { color: colors.primary, fontSize: 12, fontWeight: "600" },

  progressWrap: { marginVertical: spacing.md },
  progressTrack: { height: 4, backgroundColor: colors.cardBorder, borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: colors.primary },
  progressText: { color: colors.textMuted, textAlign: "center", fontSize: 12, marginTop: 4 },

  reviewActions: { flexDirection: "row", gap: spacing.md, paddingTop: spacing.md },
  reRecordAllBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.card, borderRadius: radius.xl, paddingVertical: 16, gap: 8,
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  reRecordAllText: { color: colors.text, fontWeight: "600" },
  submitBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16, gap: 8,
  },
  submitText: { color: "#fff", fontWeight: "700" },

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
  clipCountPill: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: colors.greenMuted, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  clipCountText: { color: colors.green, fontSize: 11, fontWeight: "700" },
  aiCueBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: colors.primaryMuted, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full,
  },
  aiCueBtnText: { color: colors.primary, fontSize: 12, fontWeight: "600" },
  aiReadyChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6 },
  aiReadyText: { color: colors.green, fontSize: 12, fontWeight: "600" },
  finishBtn: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 6, borderRadius: radius.full },
  finishBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },

  teleprompterScroll: { paddingHorizontal: 12, paddingTop: 8 },

  sceneHeading: {
    color: colors.textMuted, fontSize: 10, fontWeight: "700",
    letterSpacing: 1, textTransform: "uppercase",
    marginTop: 10, marginBottom: 4, paddingHorizontal: 10,
  },

  lineRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: radius.md, marginBottom: 4, gap: 8,
  },
  lineActiveActor: { backgroundColor: "rgba(214,48,49,0.18)", borderWidth: 1, borderColor: "rgba(214,48,49,0.5)" },
  lineActiveCue: { backgroundColor: "rgba(0,206,201,0.12)", borderWidth: 1, borderColor: "rgba(0,206,201,0.3)" },
  lineActiveNarrator: { backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  linePast: { opacity: 0.4 },

  charLabel: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm, minWidth: 60, alignItems: "center" },
  charLabelActor: { backgroundColor: "rgba(214,48,49,0.22)" },
  charLabelOther: { backgroundColor: "rgba(255,255,255,0.08)" },
  charLabelNarrator: { backgroundColor: "rgba(255,255,255,0.05)", minWidth: 36 },
  charLabelText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  charLabelTextActor: { color: "#ff7675" },
  charLabelTextOther: { color: colors.textSecondary },

  lineContent: { flex: 1 },
  lineText: { color: "rgba(255,255,255,0.55)", fontSize: 14, lineHeight: 19 },
  lineTextActor: { color: "rgba(255,255,255,0.85)", fontWeight: "500" },
  lineTextNarrator: { color: "rgba(255,255,255,0.5)", fontStyle: "italic" },
  lineTextActive: { color: "#fff", fontWeight: "500" },
  lineTextPast: { color: "rgba(255,255,255,0.3)" },

  lineStatus: { width: 24, alignItems: "center" },

  hintBar: { paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)" },
  hintText: { color: colors.textMuted, fontSize: 12, textAlign: "center" },

  controlsBar: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    paddingBottom: 44, paddingTop: 16, alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  controlsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: "82%" },
  controlBtn: { width: 60, height: 56, alignItems: "center", justifyContent: "center", gap: 3 },
  controlLabel: { color: "rgba(255,255,255,0.8)", fontSize: 11, fontWeight: "500" },
  recordBtn: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 4, borderColor: "rgba(255,255,255,0.8)",
    alignItems: "center", justifyContent: "center",
  },
  recordBtnActive: { borderColor: colors.red },
  recordDot: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.red },
  stopIcon: { width: 28, height: 28, borderRadius: 4, backgroundColor: colors.red },
  nextBtn: { width: 80, height: 80, borderRadius: 40, backgroundColor: "rgba(108,92,231,0.9)", alignItems: "center", justifyContent: "center" },
  nextBtnLabel: { color: "#fff", fontSize: 11, fontWeight: "700", marginTop: -2 },
});
