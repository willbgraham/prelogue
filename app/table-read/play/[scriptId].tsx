import { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from "expo-router";
import { Audio } from "expo-av";
import { useVideoPlayer, VideoView } from "expo-video";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { ErrorState } from "@/components/ErrorState";
import { prepareVoiceCues, VoiceCueEntry } from "@/lib/voiceCues";
import type { ParsedScript } from "@/lib/types";
import { colors, radius, spacing } from "@/lib/theme";

// Soft paper-white for the screenplay "page" — gentler than pure #fff.
// Courier Prime gives the authentic typed-screenplay feel.
const PAGE_BG = "#F7F6F2";
const MONO = "CourierPrime_400Regular";

interface Row {
  elementIndex: number;
  kind: "line" | "narrator";
  character?: string;
  text: string;
  sceneHeading?: string;
  castActor?: string | null;
}
/** A cast actor's recorded clip for one line. */
interface ClipMedia {
  uri: string;
  actor: string;
  trimStart: number;
  trimEnd: number | null;
  volume: number;
}

/** A clip submission that can read a role (one actor's per-line video). */
interface CastSub {
  id: string;
  character_id: string;
  characterName: string; // UPPER
  actor: string;
  avatar: string | null;
  isWritersChoice: boolean;
  chosenCount: number;
  clips: { element_index: number; clip_url: string; trim_start?: number; trim_end?: number; volume?: number }[];
}
interface CastRole {
  characterId: string;
  name: string;
  options: CastSub[]; // ranked most-chosen first
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
  const { session } = useAuth();
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
  const [reveal, setReveal] = useState(0); // chars of the current line typed so far
  const [progress, setProgress] = useState(0); // voice-generation progress 0..1
  const [castRoles, setCastRoles] = useState<CastRole[]>([]);
  const [castSheetOpen, setCastSheetOpen] = useState(false);
  const [castVersion, setCastVersion] = useState(0);

  const manifestRef = useRef<Map<number, VoiceCueEntry>>(new Map());
  const clipsRef = useRef<Map<number, ClipMedia>>(new Map());
  const clipEndRef = useRef<number | null>(null); // active clip's trim-end (seconds), or null
  const soundRef = useRef<Audio.Sound | null>(null);
  const playingRef = useRef(false);
  const activeRef = useRef(0);
  const mediumRef = useRef<Medium>("idle");
  const pageScrollRef = useRef<ScrollView>(null);
  const aliveRef = useRef(true);
  const focusedRef = useRef(true);
  const preparingRef = useRef(false);
  // Viewer casting
  const activeByCharRef = useRef<Map<string, string>>(new Map()); // characterId → submissionId
  const subsByIdRef = useRef<Map<string, CastSub>>(new Map());
  const urlByPathRef = useRef<Map<string, string>>(new Map());
  const castByNameRef = useRef<Map<string, { actor: string; hasClip: boolean }>>(new Map());

  // One persistent video player drives the "stage" for cast actors' clips.
  const videoPlayer = useVideoPlayer("", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.3;
  });
  // A second player drives the in-sheet "preview this read" (the actor's own
  // clips played back-to-back so you can see + hear them before casting).
  const previewPlayer = useVideoPlayer("", (p) => {
    p.loop = false;
  });
  const [previewSubId, setPreviewSubId] = useState<string | null>(null);
  const previewClipsRef = useRef<string[]>([]);
  const previewIdxRef = useRef(0);

  useEffect(() => {
    load();
    return () => {
      aliveRef.current = false;
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

  // Honor a clip's trim-end: advance early when the trimmed range finishes.
  useEffect(() => {
    const sub = videoPlayer.addListener("timeUpdate", ({ currentTime }) => {
      if (
        clipEndRef.current != null &&
        currentTime >= clipEndRef.current &&
        playingRef.current &&
        mediumRef.current === "video"
      ) {
        clipEndRef.current = null;
        advance(activeRef.current);
      }
    });
    return () => sub.remove();
  }, [videoPlayer]);

  // Preview: play the actor's clips back-to-back, then stop.
  useEffect(() => {
    const sub = previewPlayer.addListener("playToEnd", () => {
      const urls = previewClipsRef.current;
      const next = previewIdxRef.current + 1;
      if (next < urls.length) {
        previewIdxRef.current = next;
        previewPlayer.replace(urls[next]);
        previewPlayer.play();
      } else {
        setPreviewSubId(null);
      }
    });
    return () => sub.remove();
  }, [previewPlayer]);

  function stopPreview() {
    try {
      previewPlayer.pause();
    } catch {}
    setPreviewSubId(null);
  }

  function previewActor(opt: CastSub) {
    if (previewSubId === opt.id) {
      stopPreview();
      return;
    }
    const urls = [...opt.clips]
      .sort((a, b) => a.element_index - b.element_index)
      .map((c) => urlByPathRef.current.get(c.clip_url))
      .filter((u): u is string => !!u);
    if (!urls.length) return;
    // Don't double up with the main read.
    playingRef.current = false;
    setPlaying(false);
    soundRef.current?.pauseAsync().catch(() => {});
    try {
      videoPlayer.pause();
    } catch {}
    previewClipsRef.current = urls;
    previewIdxRef.current = 0;
    setPreviewSubId(opt.id);
    previewPlayer.replace(urls[0]);
    previewPlayer.play();
  }

  // Keep the latest typed text in view as a narrator/AI line types out.
  useEffect(() => {
    pageScrollRef.current?.scrollToEnd({ animated: false });
  }, [reveal]);

  // Pause everything when the screen loses focus; the play button resumes.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      return () => {
        focusedRef.current = false;
        playingRef.current = false;
        setPlaying(false);
        soundRef.current?.pauseAsync().catch(() => {});
        try {
          videoPlayer.pause();
          previewPlayer.pause();
        } catch {}
      };
    }, [videoPlayer, previewPlayer])
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

      // Load every per-line clip submission for the script + this viewer's picks.
      const { data: subsRaw } = await supabase
        .from("submissions")
        .select(
          "*, character:characters!submissions_character_id_fkey(id, name), actor:users!submissions_actor_id_fkey(id, display_name, avatar_url)"
        )
        .eq("script_id", scriptId);

      const userId = session?.user?.id ?? null;
      const myChoices: Record<string, string> = {};
      if (userId) {
        try {
          const { data: cc } = await supabase
            .from("casting_choices")
            .select("character_id, submission_id")
            .eq("script_id", scriptId)
            .eq("user_id", userId);
          for (const c of (cc as any[]) ?? []) myChoices[c.character_id] = c.submission_id;
        } catch {
          // casting_choices not migrated yet → no saved picks
        }
      }

      const subsById = new Map<string, CastSub>();
      const byChar = new Map<string, CastSub[]>();
      const charNames = new Map<string, string>();
      const allPaths = new Set<string>();
      for (const sub of (subsRaw as any[]) ?? []) {
        const clips = Array.isArray(sub.clips)
          ? sub.clips.filter((c: any) => c && typeof c.element_index === "number" && c.clip_url)
          : [];
        if (!clips.length) continue; // need per-line clips to splice into the read
        const charId = sub.character?.id ?? sub.character_id;
        if (!charId) continue;
        const cs: CastSub = {
          id: sub.id,
          character_id: charId,
          characterName: (sub.character?.name ?? "").toUpperCase(),
          actor: sub.actor?.display_name ?? "Actor",
          avatar: sub.actor?.avatar_url ?? null,
          isWritersChoice: !!sub.is_writers_choice,
          chosenCount: sub.chosen_count ?? 0,
          clips,
        };
        subsById.set(cs.id, cs);
        charNames.set(charId, sub.character?.name ?? cs.characterName);
        if (!byChar.has(charId)) byChar.set(charId, []);
        byChar.get(charId)!.push(cs);
        for (const c of clips) allPaths.add(c.clip_url);
      }

      // Sign every clip path once — switching casts is then instant.
      const urlByPath = new Map<string, string>();
      const paths = [...allPaths];
      if (paths.length) {
        const { data: signed } = await supabase.storage
          .from("submissions")
          .createSignedUrls(paths, 86400);
        paths.forEach((p, i) => urlByPath.set(p, signed?.[i]?.signedUrl ?? ""));
      }

      // Rank each role's actors (most chosen → Writer's Choice tiebreak) and set
      // the active one — this viewer's saved pick wins, else the top-ranked.
      const roles: CastRole[] = [];
      const activeByChar = new Map<string, string>();
      for (const [charId, list] of byChar) {
        list.sort(
          (a, b) =>
            b.chosenCount - a.chosenCount ||
            Number(b.isWritersChoice) - Number(a.isWritersChoice)
        );
        roles.push({ characterId: charId, name: charNames.get(charId) ?? list[0].characterName, options: list });
        const mine = myChoices[charId];
        const active = (mine && list.find((sb) => sb.id === mine)?.id) || list[0].id;
        activeByChar.set(charId, active);
      }

      subsByIdRef.current = subsById;
      urlByPathRef.current = urlByPath;
      activeByCharRef.current = activeByChar;
      setCastRoles(roles);
      recomputeClips();

      setRows(buildRows(script.parsed_json as any, {}));
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
    if (preparingRef.current) return; // ignore re-taps while already preparing
    preparingRef.current = true;
    setPreparing(true);
    setProgress(0);
    try {
      const map = await prepareVoiceCues(
        scriptId,
        (p) => setProgress(p),
        () => !aliveRef.current || !focusedRef.current
      );
      // If we left the screen while preparing, don't auto-start (this is what
      // caused the "double play" — a stale prepare resuming playback).
      if (!aliveRef.current || !focusedRef.current) return;
      manifestRef.current = map;
      setReady(true);
      startFrom(0);
    } catch (e: any) {
      Alert.alert("Couldn't prepare voices", e?.message ?? String(e));
    } finally {
      preparingRef.current = false;
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

  // Rebuild the line→clip map (and per-role active-actor labels) from whichever
  // submission is active for each character. Called on load and on each re-cast.
  function recomputeClips() {
    const clipMap = new Map<number, ClipMedia>();
    const nameMap = new Map<string, { actor: string; hasClip: boolean }>();
    for (const [, subId] of activeByCharRef.current) {
      const sub = subsByIdRef.current.get(subId);
      if (!sub) continue;
      nameMap.set(sub.characterName, { actor: sub.actor, hasClip: sub.clips.length > 0 });
      for (const c of sub.clips) {
        const uri = urlByPathRef.current.get(c.clip_url);
        if (uri)
          clipMap.set(c.element_index, {
            uri,
            actor: sub.actor,
            trimStart: c.trim_start ?? 0,
            trimEnd: c.trim_end ?? null,
            volume: c.volume ?? 1,
          });
      }
    }
    clipsRef.current = clipMap;
    castByNameRef.current = nameMap;
    setClipCount(clipMap.size);
  }

  // The viewer picks an actor for a role: re-cast instantly + remember it.
  async function chooseActor(characterId: string, submissionId: string) {
    const prev = activeByCharRef.current.get(characterId);
    if (prev === submissionId) {
      setCastSheetOpen(false);
      return;
    }
    activeByCharRef.current.set(characterId, submissionId);
    // Optimistic local tally so the picker reflects it immediately.
    const next = subsByIdRef.current.get(submissionId);
    const old = prev ? subsByIdRef.current.get(prev) : undefined;
    if (next) next.chosenCount += 1;
    if (old && old.chosenCount > 0) old.chosenCount -= 1;
    recomputeClips();
    setCastVersion((v) => v + 1);
    const userId = session?.user?.id;
    if (userId) {
      try {
        await supabase.from("casting_choices").upsert(
          {
            user_id: userId,
            script_id: scriptId,
            character_id: characterId,
            submission_id: submissionId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,character_id" }
        );
      } catch {
        // casting_choices not migrated yet — the pick still applies this session
      }
    }
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
        clipEndRef.current = clip.trimEnd;
        videoPlayer.replace(clip.uri);
        videoPlayer.volume = clip.volume;
        videoPlayer.currentTime = clip.trimStart;
        videoPlayer.play();
      } catch (err) {
        console.warn("Clip playback error:", err);
        if (playingRef.current) setTimeout(() => advance(rowPos), 200);
      }
      return; // the playToEnd / trim-end listener advances
    }
    clipEndRef.current = null;

    // ---- AI voice — type the line onto a screenplay page as it's read ----
    setMediumState("audio");
    setReveal(0);
    try {
      videoPlayer.pause();
    } catch {}
    const textLen = row.text.length;
    const cue = manifestRef.current.get(row.elementIndex);
    if (!cue?.signedUrl) {
      setReveal(textLen); // no audio — show the whole line, then move on
      if (playingRef.current) setTimeout(() => advance(rowPos), 30);
      return;
    }
    try {
      await unloadAudio();
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: cue.signedUrl },
        { shouldPlay: true, progressUpdateIntervalMillis: 80 }
      );
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) return;
        // Reveal text in step with how far the narration has played.
        if (mediumRef.current === "audio") {
          const dur = status.durationMillis ?? 0;
          if (dur > 0) {
            const frac = Math.min(1, (status.positionMillis ?? 0) / dur);
            setReveal(Math.max(1, Math.ceil(textLen * frac)));
          }
        }
        if (status.didJustFinish && playingRef.current && mediumRef.current === "audio") {
          setReveal(textLen);
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
        <Stack.Screen options={{ title: "Table Read", headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (loadError) {
    return (
      <View style={[s.center, { justifyContent: "center" }]}>
        <Stack.Screen options={{ title: "Table Read", headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
        <ErrorState onRetry={() => { setLoading(true); load(); }} />
      </View>
    );
  }
  if (rows.length === 0) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: "Table Read", headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
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
    const castInfo = item.character ? castByNameRef.current.get(item.character.toUpperCase()) : undefined;
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
              <Text style={[s.tagCharText, s.tagNarratorText]} numberOfLines={1}>
                Narrator
              </Text>
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
            {castInfo ? (
              <View style={s.castBadge}>
                <Feather name={hasClip ? "video" : "user-check"} size={10} color={colors.green} />
                <Text style={s.castBadgeText}>{castInfo.actor}{hasClip ? "" : " (voice)"}</Text>
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
      <Stack.Screen options={{ title, headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />

      {castRoles.length > 0 && (
        <TouchableOpacity style={s.castBtn} onPress={() => setCastSheetOpen(true)} activeOpacity={0.85}>
          <Feather name="users" size={13} color="#fff" />
          <Text style={s.castBtnText}>Choose Cast</Text>
        </TouchableOpacity>
      )}

      {/* Stage — always visible: the cast actor's clip, or the current line on a
          "page" (full text when idle, typing out as it's read). */}
      <View style={s.stage}>
        <VideoView player={videoPlayer} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
          {medium !== "video" && (
            <View style={s.page}>
              {activeRow?.sceneHeading ? (
                <Text style={s.pageSlug} numberOfLines={1}>{activeRow.sceneHeading}</Text>
              ) : null}
              <ScrollView
                ref={pageScrollRef}
                style={s.pageScroll}
                contentContainerStyle={s.pageScrollContent}
                showsVerticalScrollIndicator={false}
              >
                {activeRow?.kind === "line" && activeRow.character ? (
                  <Text style={s.pageChar}>{activeRow.character}</Text>
                ) : null}
                <Text style={activeRow?.kind === "narrator" ? s.pageAction : s.pageDialogue}>
                  {playing ? (activeRow?.text ?? "").slice(0, reveal) : (activeRow?.text ?? "")}
                  {playing && reveal < (activeRow?.text?.length ?? 0) ? (
                    <Text style={s.cursor}>▌</Text>
                  ) : null}
                </Text>
              </ScrollView>
            </View>
          )}
          {medium === "video" && activeClip && (
            <View style={s.stageTag}>
              <Feather name="user-check" size={12} color="#fff" />
              <Text style={s.stageTagText}>{activeClip.actor}</Text>
            </View>
          )}
        </View>

      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(_i, i) => String(i)}
        renderItem={renderRow}
        extraData={`${active}-${playing}-${medium}-${clipCount}-${castVersion}`}
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
          preparing ? (
            <View style={s.prepWrap}>
              <View style={s.prepTrack}>
                <View style={[s.prepFill, { width: `${Math.round(progress * 100)}%` }]} />
              </View>
              <Text style={s.prepText}>Generating AI voices… {Math.round(progress * 100)}%</Text>
            </View>
          ) : (
            <TouchableOpacity style={s.playBtn} onPress={prepareAndPlay} activeOpacity={0.85}>
              <Feather name="play" size={18} color="#fff" />
              <Text style={s.playBtnText}>
                Play Table Read{clipCount > 0 ? "  ·  with cast" : ""}
              </Text>
            </TouchableOpacity>
          )
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

      {/* Choose-cast sheet */}
      {castSheetOpen && (
        <View style={s.sheetOverlay}>
          <View style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>Choose your cast</Text>
              <TouchableOpacity onPress={() => { stopPreview(); setCastSheetOpen(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Feather name="x" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={s.sheetSub}>
              Pick who reads each role — ranked by how often viewers pick them.
            </Text>
            {previewSubId && (
              <View style={s.previewWrap}>
                <VideoView player={previewPlayer} style={s.previewVideo} contentFit="contain" nativeControls={false} />
              </View>
            )}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
              {castRoles.map((role) => {
                const activeId = activeByCharRef.current.get(role.characterId);
                return (
                  <View key={role.characterId} style={s.roleBlock}>
                    <Text style={s.roleName}>{role.name}</Text>
                    {role.options.map((opt) => {
                      const isSel = opt.id === activeId;
                      return (
                        <TouchableOpacity
                          key={opt.id}
                          style={[s.optRow, isSel && s.optRowActive]}
                          onPress={() => chooseActor(role.characterId, opt.id)}
                          activeOpacity={0.8}
                        >
                          {opt.avatar ? (
                            <Image source={{ uri: opt.avatar }} style={s.optAvatar} />
                          ) : (
                            <View style={s.optAvatarPh}>
                              <Feather name="user" size={16} color={colors.primary} />
                            </View>
                          )}
                          <View style={{ flex: 1 }}>
                            <Text style={s.optName}>{opt.actor}</Text>
                            <Text style={s.optMeta}>
                              {opt.chosenCount} pick{opt.chosenCount === 1 ? "" : "s"}
                              {opt.isWritersChoice ? " · Writer's Choice" : ""}
                            </Text>
                          </View>
                          <TouchableOpacity
                            onPress={() => previewActor(opt)}
                            style={s.previewBtn}
                            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                          >
                            <Feather
                              name={previewSubId === opt.id ? "pause" : "play"}
                              size={12}
                              color={colors.primary}
                            />
                            <Text style={s.previewBtnText}>
                              {previewSubId === opt.id ? "Stop" : "Preview"}
                            </Text>
                          </TouchableOpacity>
                          <Feather
                            name={isSel ? "check-circle" : "circle"}
                            size={20}
                            color={isSel ? colors.green : colors.cardBorder}
                          />
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, paddingHorizontal: 32 },
  emptyText: { color: colors.textSecondary, fontSize: 15, marginTop: 12, textAlign: "center" },

  // Stage
  stage: {
    width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000",
    alignItems: "center", justifyContent: "center",
    borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
  },
  // Screenplay "page" shown while the AI reads (typed out in sync with speech).
  page: { ...StyleSheet.absoluteFillObject, backgroundColor: PAGE_BG, paddingHorizontal: 24, paddingVertical: 16 },
  pageSlug: { fontFamily: MONO, fontSize: 11, fontWeight: "700", color: "#8a8a8a", letterSpacing: 1, marginBottom: 10, textTransform: "uppercase" },
  pageScroll: { flex: 1 },
  pageScrollContent: { flexGrow: 1, justifyContent: "center" },
  pageChar: { fontFamily: MONO, fontSize: 15, fontWeight: "700", color: "#1a1a1a", textAlign: "center", letterSpacing: 1, marginBottom: 6 },
  pageDialogue: { fontFamily: MONO, fontSize: 16, color: "#222", textAlign: "center", lineHeight: 24, paddingHorizontal: 8 },
  pageAction: { fontFamily: MONO, fontSize: 15, color: "#333", textAlign: "left", lineHeight: 23 },
  cursor: { color: colors.primary, fontFamily: MONO, fontWeight: "700" },
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
  tagChar: { backgroundColor: "rgba(188, 64, 38,0.18)" },
  tagCharText: { color: colors.primary, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  tagNarrator: { backgroundColor: colors.elevated },
  tagNarratorText: { color: colors.textSecondary },
  lineContent: { flex: 1 },
  lineText: { color: colors.textSecondary, fontSize: 15, lineHeight: 21, fontFamily: MONO },
  lineTextNarrator: { fontStyle: "italic", color: colors.textMuted },
  lineTextActive: { color: colors.text, fontWeight: "500" },
  lineTextPast: { color: colors.textMuted },
  castBadge: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4, alignSelf: "flex-start", backgroundColor: colors.greenMuted, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  castBadgeText: { color: colors.green, fontSize: 10, fontWeight: "600" },

  transport: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: 36, backgroundColor: colors.elevated, borderTopWidth: 1, borderTopColor: colors.cardBorder },
  playBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16 },
  playBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  prepWrap: { paddingVertical: 12, gap: 8 },
  prepTrack: { height: 6, backgroundColor: colors.cardBorder, borderRadius: 3, overflow: "hidden" },
  prepFill: { height: "100%", backgroundColor: colors.primary, borderRadius: 3 },
  prepText: { color: colors.textSecondary, fontSize: 13, textAlign: "center", fontWeight: "600" },
  transportRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xxl },
  transportSecondary: { width: 56, alignItems: "center" },
  transportPlay: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  progressText: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },

  // Choose-cast
  castBtn: {
    position: "absolute", top: 10, right: 14, zIndex: 30,
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(188, 64, 38,0.95)", paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full,
  },
  castBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  sheetOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end", zIndex: 50 },
  sheet: {
    maxHeight: "82%", backgroundColor: colors.bg,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: spacing.xl, borderTopWidth: 1, borderColor: colors.cardBorder,
  },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "800" },
  sheetSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 4, marginBottom: spacing.md },
  roleBlock: { marginBottom: spacing.lg },
  roleName: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 },
  optRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, marginBottom: 8,
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  optRowActive: { borderColor: colors.green, backgroundColor: colors.greenMuted },
  optAvatar: { width: 52, height: 52, borderRadius: radius.full },
  optAvatarPh: { width: 52, height: 52, borderRadius: radius.full, backgroundColor: colors.primaryMuted, alignItems: "center", justifyContent: "center" },
  optName: { color: colors.text, fontSize: 14, fontWeight: "600" },
  optMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  previewWrap: { height: 200, backgroundColor: "#000", borderRadius: radius.lg, overflow: "hidden", marginBottom: spacing.md },
  previewVideo: { flex: 1 },
  previewBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.cardBorder, backgroundColor: colors.elevated,
  },
  previewBtnText: { color: colors.primary, fontSize: 11, fontWeight: "700" },
});
