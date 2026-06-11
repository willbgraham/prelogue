import { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
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
import type { Character, ParsedScript } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface DialogueLine {
  character: string;
  text: string;
  isActor: boolean;
  /** Index into the manifest cue array (only for non-actor lines) */
  cueIndex?: number;
}

interface ManifestCue {
  index: number;
  character: string;
  text: string;
  audio_url: string;
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
  const scrollRef = useRef<ScrollView>(null);
  const lineRefs = useRef<Record<number, number>>({});

  const [permission, requestPermission] = useCameraPermissions();
  const [character, setCharacter] = useState<Character | null>(null);
  const [dialogueLines, setDialogueLines] = useState<DialogueLine[]>([]);
  const [activeLine, setActiveLine] = useState(0);
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState(false);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [facing, setFacing] = useState<"front" | "back">("front");

  // AI cues
  const [aiCueReady, setAiCueReady] = useState(false);
  const [generatingCues, setGeneratingCues] = useState(false);
  const [manifest, setManifest] = useState<ManifestCue[]>([]);
  const [playingCue, setPlayingCue] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);

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

  // Pulse animation when it's actor's turn
  useEffect(() => {
    if (dialogueLines[activeLine]?.isActor && recording) {
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
    const { data } = await supabase
      .from("characters")
      .select("*, script:scripts(id, title, parsed_json)")
      .eq("id", characterId)
      .single();

    if (data) {
      setCharacter(data as any);
      buildInterleaved((data as any).script?.parsed_json, data.name);
    }
    setLoading(false);
  }

  /**
   * Build interleaved dialogue from the parsed script.
   * Since characters store lines with scene_index, we interleave by
   * alternating through characters' line arrays to simulate dialogue order.
   */
  function buildInterleaved(parsed: ParsedScript | undefined, actorName: string) {
    if (!parsed?.characters) return;

    const actorUpper = actorName.toUpperCase();
    const actorChar = parsed.characters.find((c) => c.name.toUpperCase() === actorUpper);
    const otherChars = parsed.characters.filter((c) => c.name.toUpperCase() !== actorUpper);

    if (!actorChar) return;

    // Build interleaved: for each actor line, insert preceding cue lines from others
    const lines: DialogueLine[] = [];
    let cueIdx = 0;

    // Take up to 20 actor lines for a manageable recording session
    const actorLines = actorChar.lines.slice(0, 20);

    // Distribute other characters' lines between actor lines
    const otherLines: { character: string; text: string }[] = [];
    for (const oc of otherChars) {
      for (const line of oc.lines.slice(0, 15)) {
        otherLines.push({ character: oc.name, text: line.text });
      }
    }

    let otherIdx = 0;
    for (let i = 0; i < actorLines.length; i++) {
      // Add 1-2 cue lines before each actor line
      const cuesBeforeThis = Math.min(2, otherLines.length - otherIdx);
      for (let j = 0; j < cuesBeforeThis; j++) {
        lines.push({
          character: otherLines[otherIdx].character,
          text: otherLines[otherIdx].text,
          isActor: false,
          cueIndex: cueIdx++,
        });
        otherIdx++;
      }
      // Actor's line
      lines.push({
        character: actorName,
        text: actorLines[i].text,
        isActor: true,
      });
    }

    setDialogueLines(lines);
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
    setGeneratingCues(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "generate-voice-cues",
        { body: { character_id: characterId } }
      );

      if (error) {
        console.warn("Voice cue error:", error);
        Alert.alert("AI Cues Error", String(error?.message ?? error));
        return;
      }

      // Fetch the manifest to get audio URLs
      const manifestPath = data?.manifest_path;
      if (manifestPath) {
        const { data: signedUrlData } = await supabase.storage
          .from("scripts")
          .createSignedUrl(manifestPath, 86400);
        if (signedUrlData?.signedUrl) {
          const res = await fetch(signedUrlData.signedUrl);
          const cues: ManifestCue[] = await res.json();
          setManifest(cues);
        }
      }

      setAiCueReady(true);
      const count = data?.cues_generated ?? 0;
      Alert.alert(
        "AI Cues Ready",
        `${count} voice cues loaded! Tap other characters' lines to hear them read aloud.`
      );
    } catch (err: any) {
      console.warn("AI cue exception:", err);
      Alert.alert("AI Cues Error", err?.message ?? String(err));
    } finally {
      setGeneratingCues(false);
    }
  }

  async function playCue(cueIndex: number) {
    if (!manifest.length || cueIndex >= manifest.length) return;
    const cue = manifest[cueIndex];
    if (!cue?.audio_url) return;

    try {
      // Stop any currently playing cue
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
      }

      setPlayingCue(true);
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: recording,
        playsInSilentModeIOS: true,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri: cue.audio_url },
        { shouldPlay: true }
      );
      soundRef.current = sound;

      // Auto-advance when cue finishes
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingCue(false);
          advanceLine();
        }
      });
    } catch (err) {
      console.warn("Cue playback error:", err);
      setPlayingCue(false);
    }
  }

  function advanceLine() {
    setActiveLine((prev) => {
      const next = Math.min(prev + 1, dialogueLines.length - 1);
      // Scroll to the new active line
      setTimeout(() => {
        scrollRef.current?.scrollTo({ y: Math.max(0, (next - 1) * 52), animated: true });
      }, 100);
      return next;
    });
  }

  function handleLineTap(index: number) {
    setActiveLine(index);
    const line = dialogueLines[index];
    if (!line.isActor && aiCueReady && line.cueIndex != null) {
      playCue(line.cueIndex);
    }
    // Scroll into view
    setTimeout(() => {
      scrollRef.current?.scrollTo({ y: Math.max(0, (index - 1) * 52), animated: true });
    }, 100);
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------
  async function startRecording() {
    if (!cameraRef.current) return;
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    setRecording(true);
    setActiveLine(0);
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

  if (!permission?.granted) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: "Permission", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
        <Feather name="camera" size={40} color={colors.textMuted} />
        <Text style={s.permTitle}>Camera Access Required</Text>
        <Text style={s.permSub}>We need camera and microphone access to record your audition.</Text>
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
  // Recording view with interleaved teleprompter
  // -------------------------------------------------------------------------
  return (
    <>
      <Stack.Screen options={{ title: character?.name ?? "Recording", headerStyle: { backgroundColor: colors.bg }, headerTintColor: "#fff" }} />
      <View style={s.cameraContainer}>
        <CameraView ref={cameraRef} style={{ flex: 1 }} facing={facing} mode="video">
          {/* Teleprompter overlay */}
          <View style={s.teleprompter}>
            {/* Header */}
            <View style={s.teleprompterHeader}>
              <View style={s.headerLeft}>
                <Text style={s.teleprompterTitle}>
                  {recording ? "Recording" : "Script"}
                </Text>
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
                <View style={s.aiCueReady}>
                  <Feather name="volume-2" size={12} color={colors.green} />
                  <Text style={s.aiCueReadyText}>AI Voices On</Text>
                </View>
              )}
            </View>

            {/* Interleaved dialogue */}
            <ScrollView
              ref={scrollRef}
              style={s.teleprompterScroll}
              showsVerticalScrollIndicator={false}
            >
              {dialogueLines.map((line, i) => {
                const isActive = activeLine === i;
                const isPast = i < activeLine;
                const isCuePlaying = isActive && playingCue && !line.isActor;

                return (
                  <TouchableOpacity
                    key={i}
                    style={[
                      s.lineRow,
                      isActive && (line.isActor ? s.lineActiveActor : s.lineActiveCue),
                      isPast && s.linePast,
                    ]}
                    onPress={() => handleLineTap(i)}
                    activeOpacity={0.7}
                  >
                    {/* Character label */}
                    <View style={[s.charLabel, line.isActor ? s.charLabelActor : s.charLabelOther]}>
                      <Text
                        style={[s.charLabelText, line.isActor ? s.charLabelTextActor : s.charLabelTextOther]}
                        numberOfLines={1}
                      >
                        {line.character}
                      </Text>
                    </View>

                    {/* Line text */}
                    <View style={s.lineContent}>
                      <Text
                        style={[
                          s.lineText,
                          line.isActor && s.lineTextActor,
                          isActive && s.lineTextActive,
                          isPast && s.lineTextPast,
                        ]}
                        numberOfLines={3}
                      >
                        {line.text}
                      </Text>
                    </View>

                    {/* Status indicator */}
                    <View style={s.lineStatus}>
                      {isCuePlaying ? (
                        <Animated.View style={{ opacity: pulseAnim }}>
                          <Feather name="volume-2" size={14} color={colors.teal} />
                        </Animated.View>
                      ) : line.isActor && isActive ? (
                        <Animated.View style={{ opacity: pulseAnim }}>
                          <Feather name="mic" size={14} color={colors.primary} />
                        </Animated.View>
                      ) : !line.isActor && aiCueReady ? (
                        <Feather name="play" size={12} color={colors.textMuted} />
                      ) : isPast ? (
                        <Feather name="check" size={12} color={colors.green} />
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
              <View style={{ height: 40 }} />
            </ScrollView>

            {/* Instruction hint */}
            <View style={s.hintBar}>
              {dialogueLines[activeLine]?.isActor ? (
                <Text style={s.hintText}>
                  <Text style={{ color: colors.primary }}>Your line</Text> — perform it, then tap to advance
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
                disabled={!recording && activeLine >= dialogueLines.length - 1}
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
    backgroundColor: "rgba(0,0,0,0.85)", maxHeight: "55%",
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
  aiCueReady: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 6 },
  aiCueReadyText: { color: colors.green, fontSize: 12, fontWeight: "600" },

  teleprompterScroll: { paddingHorizontal: 12, paddingTop: 8, maxHeight: 280 },

  // Dialogue lines
  lineRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: radius.md, marginBottom: 4, gap: 8,
  },
  lineActiveActor: { backgroundColor: "rgba(108,92,231,0.2)", borderWidth: 1, borderColor: "rgba(108,92,231,0.4)" },
  lineActiveCue: { backgroundColor: "rgba(0,206,201,0.12)", borderWidth: 1, borderColor: "rgba(0,206,201,0.3)" },
  linePast: { opacity: 0.4 },

  charLabel: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm,
    minWidth: 60, alignItems: "center",
  },
  charLabelActor: { backgroundColor: colors.primaryMuted },
  charLabelOther: { backgroundColor: "rgba(255,255,255,0.08)" },
  charLabelText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  charLabelTextActor: { color: colors.primary },
  charLabelTextOther: { color: colors.textSecondary },

  lineContent: { flex: 1 },
  lineText: { color: "rgba(255,255,255,0.55)", fontSize: 14, lineHeight: 19 },
  lineTextActor: { color: "rgba(255,255,255,0.7)" },
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
