import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Linking,
  Alert,
  TextInput,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useRequireAuth } from "@/lib/useRequireAuth";
import { uploadFile } from "@/lib/storage";
import { SCRIPT_STATUS_LABELS } from "@/lib/constants";
import { reportContent, blockUser } from "@/lib/moderation";
import { startScriptUnlock, UNLOCK_PRICE_LABEL } from "@/lib/billing";
import { colors, radius, spacing, genreColors } from "@/lib/theme";

export default function ScriptDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const { requireAuth } = useRequireAuth();
  const [script, setScript] = useState<any>(null);
  const [characters, setCharacters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [posterUploading, setPosterUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [invites, setInvites] = useState<any[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [addingInvite, setAddingInvite] = useState(false);

  useEffect(() => {
    fetchScript();
  }, [id]);

  async function fetchScript() {
    const [scriptRes, charRes] = await Promise.all([
      supabase.from("scripts").select("*").eq("id", id).single(),
      supabase
        .from("characters")
        .select("*, submissions(count)")
        .eq("script_id", id)
        .order("line_count", { ascending: false }),
    ]);

    if (scriptRes.data) {
      setScript(scriptRes.data);
      if (scriptRes.data.writer_id === session?.user?.id) fetchInvites();
    }
    if (charRes.data) {
      setCharacters(
        charRes.data.map((c: any) => ({
          ...c,
          submission_count: c.submissions?.[0]?.count ?? 0,
        }))
      );
    }
    setLoading(false);
  }

  async function fetchInvites() {
    const { data } = await supabase
      .from("script_invites")
      .select("id, email")
      .eq("script_id", id)
      .order("created_at", { ascending: true });
    setInvites(data ?? []);
  }

  function openScript() {
    router.push(`/script/read?id=${script.id}` as any);
  }

  async function viewCopyrightDoc() {
    if (!script?.copyright_doc_url) return;
    const { data } = await supabase.storage
      .from("scripts")
      .createSignedUrl(script.copyright_doc_url, 3600);
    if (data?.signedUrl) Linking.openURL(data.signedUrl);
  }

  async function viewTreatment() {
    if (!script?.treatment_url) return;
    const { data } = await supabase.storage
      .from("scripts")
      .createSignedUrl(script.treatment_url, 3600);
    if (data?.signedUrl) Linking.openURL(data.signedUrl);
  }

  async function pickPoster() {
    if (!session) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Please allow access to your photo library.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    try {
      setPosterUploading(true);
      const asset = result.assets[0];
      const ext = asset.uri.split(".").pop() || "jpg";
      const path = `${session.user.id}/${Date.now()}-poster.${ext}`;
      await uploadFile("avatars", path, asset.uri, `image/${ext}`);
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      await supabase.from("scripts").update({ cover_image_url: data.publicUrl }).eq("id", script.id);
      setScript({ ...script, cover_image_url: data.publicUrl });
    } catch (e: any) {
      Alert.alert("Upload failed", e?.message ?? String(e));
    } finally {
      setPosterUploading(false);
    }
  }

  async function setVisibility(next: "public" | "hidden" | "private") {
    if (next === script.visibility) return;
    if (next === "private" && !script.full_read_unlocked) {
      Alert.alert(
        "Unlock to go invite-only",
        `Private, invite-only sharing is included when you unlock this script's full read (${UNLOCK_PRICE_LABEL}).`,
        [
          { text: "Not now", style: "cancel" },
          { text: `Unlock ${UNLOCK_PRICE_LABEL}`, onPress: unlock },
        ]
      );
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("scripts").update({ visibility: next }).eq("id", script.id);
    setBusy(false);
    if (error) {
      Alert.alert("Couldn't update", error.message);
      return;
    }
    setScript({ ...script, visibility: next });
  }

  async function unlock() {
    setUnlocking(true);
    const res = await startScriptUnlock(script.id);
    if (!res.ok) {
      setUnlocking(false);
      Alert.alert("Couldn't start checkout", res.error ?? "Please try again.");
      return;
    }
    // The browser has closed. The webhook flips the flag server-side, which can
    // lag a beat — poll the script a few times to pick it up.
    for (let i = 0; i < 5; i++) {
      const { data } = await supabase
        .from("scripts")
        .select("full_read_unlocked, unlocked_at")
        .eq("id", script.id)
        .single();
      if (data?.full_read_unlocked) {
        setScript((s: any) => ({ ...s, ...data }));
        setUnlocking(false);
        Alert.alert("Unlocked!", "Your full AI read and invite-only sharing are ready.");
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    setUnlocking(false);
    Alert.alert(
      "Finishing up",
      "If you completed payment, your unlock will appear in a moment — pull down to refresh."
    );
  }

  async function addInvite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      Alert.alert("Enter a valid email");
      return;
    }
    setAddingInvite(true);
    const { error } = await supabase
      .from("script_invites")
      .insert({ script_id: script.id, email, invited_by: session?.user?.id });
    setAddingInvite(false);
    if (error) {
      Alert.alert("Couldn't add", error.message.includes("duplicate") ? "That email is already invited." : error.message);
      return;
    }
    setInviteEmail("");
    fetchInvites();
  }

  async function removeInvite(inviteId: string) {
    setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    await supabase.from("script_invites").delete().eq("id", inviteId);
  }

  function confirmDelete() {
    Alert.alert(
      "Delete screenplay?",
      `"${script.title}" and all of its roles, reads, and casting will be permanently deleted. This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDelete },
      ]
    );
  }

  async function doDelete() {
    setBusy(true);
    const { error } = await supabase.rpc("delete_script", { p_script_id: script.id });
    setBusy(false);
    if (error) {
      Alert.alert("Couldn't delete", error.message);
      return;
    }
    router.replace("/(tabs)/scripts" as any);
  }

  if (loading || !script) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const isOwner = session?.user?.id === script.writer_id;
  const isOpen = script.status === "open";

  const genreColor = genreColors[script.genre] || colors.primary;

  return (
    <>
      <Stack.Screen
        options={{
          title: script.title,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: "#fff",
        }}
      />
      <ScrollView style={s.container}>
        {/* Cover image / poster */}
        {script.cover_image_url ? (
          <View>
            <Image source={{ uri: script.cover_image_url }} style={s.coverImage} />
            {isOwner && (
              <TouchableOpacity style={s.posterEditBtn} onPress={pickPoster} disabled={posterUploading}>
                {posterUploading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Feather name="camera" size={13} color="#fff" />
                )}
                <Text style={s.posterEditText}>{posterUploading ? "Uploading…" : "Change poster"}</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : isOwner ? (
          <TouchableOpacity style={s.posterAdd} onPress={pickPoster} disabled={posterUploading} activeOpacity={0.8}>
            {posterUploading ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Feather name="image" size={22} color={colors.textMuted} />
            )}
            <Text style={s.posterAddText}>{posterUploading ? "Uploading…" : "Add a poster (optional)"}</Text>
          </TouchableOpacity>
        ) : null}

        {/* Header */}
        <View style={s.header}>
          <View style={s.badgeRow}>
            <View style={[s.genreBadge, { backgroundColor: genreColor + "20" }]}>
              <Text style={[s.genreBadgeText, { color: genreColor }]}>
                {script.genre}
              </Text>
            </View>
            <View style={[s.statusBadge, { backgroundColor: isOpen ? colors.greenMuted : colors.elevated }]}>
              <View style={[s.statusDot, { backgroundColor: isOpen ? colors.green : colors.textMuted }]} />
              <Text style={[s.statusText, { color: isOpen ? colors.green : colors.textSecondary }]}>
                {SCRIPT_STATUS_LABELS[script.status]}
              </Text>
            </View>
            {isOwner && (script.visibility === "hidden" || script.visibility === "private") && (
              <View style={s.hiddenPill}>
                <Feather
                  name={script.visibility === "private" ? "lock" : "eye-off"}
                  size={11}
                  color={colors.textSecondary}
                />
                <Text style={s.hiddenPillText}>
                  {script.visibility === "private" ? "Private" : "Hidden"}
                </Text>
              </View>
            )}
          </View>

          <Text style={s.title}>{script.title}</Text>
          <Text style={s.logline}>{script.logline}</Text>

          {(script.copyright_doc_url || script.copyright_reg_number) && (
            <TouchableOpacity
              style={s.copyrightBadge}
              onPress={viewCopyrightDoc}
              activeOpacity={script.copyright_doc_url ? 0.8 : 1}
            >
              <Feather name="shield" size={13} color={colors.green} />
              <Text style={s.copyrightBadgeText}>
                Copyright on file{script.copyright_reg_number ? ` · ${script.copyright_reg_number}` : ""}
              </Text>
              {script.copyright_doc_url ? (
                <Feather name="external-link" size={11} color={colors.green} />
              ) : null}
            </TouchableOpacity>
          )}

          {/* Stats + Read Script */}
          <View style={s.actionRow}>
            <View style={s.statChip}>
              <Feather name="users" size={14} color={colors.primary} />
              <Text style={s.statChipText}>{characters.length} roles</Text>
            </View>

            <TouchableOpacity style={s.readScriptBtn} onPress={openScript} activeOpacity={0.8}>
              <Feather name="file-text" size={16} color={colors.primary} />
              <Text style={s.readScriptText}>Read Full Script</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={s.playAiBtn}
            onPress={() => router.push(`/table-read/play/${script.id}` as any)}
            activeOpacity={0.85}
          >
            <Feather name="play" size={16} color="#fff" />
            <Text style={s.playAiText}>Play with AI Voices</Text>
          </TouchableOpacity>

          {script.treatment_url && (
            <TouchableOpacity style={s.treatmentBtn} onPress={viewTreatment} activeOpacity={0.85}>
              <Feather name="file-text" size={16} color={colors.text} />
              <Text style={s.treatmentBtnText}>View Treatment</Text>
            </TouchableOpacity>
          )}

          {!isOwner && (
            <View style={s.modRow}>
              <TouchableOpacity style={s.modBtn} onPress={() => reportContent("script", script.id)} hitSlop={8}>
                <Feather name="flag" size={12} color={colors.textMuted} />
                <Text style={s.modText}>Report</Text>
              </TouchableOpacity>
              {script.writer_id && (
                <TouchableOpacity style={s.modBtn} onPress={() => blockUser(script.writer_id, "this writer")} hitSlop={8}>
                  <Feather name="slash" size={12} color={colors.textMuted} />
                  <Text style={s.modText}>Block writer</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        {/* Casting Dashboard button for writers */}
        {isOwner && (script.status === "open" || script.status === "casting") && (
          <TouchableOpacity
            style={s.castingBtn}
            onPress={() => router.push(`/casting/${script.id}` as any)}
            activeOpacity={0.85}
          >
            <Feather name="layout" size={16} color="#fff" />
            <Text style={s.castingBtnText}>Open Casting Dashboard</Text>
          </TouchableOpacity>
        )}

        {/* Owner management: unlock, visibility, invites, delete */}
        {isOwner && (
          <View style={s.ownerPanel}>
            {!script.full_read_unlocked ? (
              <View style={s.unlockCard}>
                <View style={s.unlockHead}>
                  <Feather name="unlock" size={16} color={colors.primary} />
                  <Text style={s.unlockTitle}>Unlock the full read</Text>
                </View>
                <Text style={s.unlockBody}>
                  Listeners currently hear a short free preview. Unlock to voice the
                  entire script with full narration, and to share it privately,
                  invite-only. One-time — yours forever.
                </Text>
                <TouchableOpacity
                  style={[s.unlockBtn, unlocking && { opacity: 0.7 }]}
                  onPress={unlock}
                  disabled={unlocking}
                  activeOpacity={0.85}
                >
                  {unlocking ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Feather name="zap" size={15} color="#fff" />
                      <Text style={s.unlockBtnText}>Unlock full read · {UNLOCK_PRICE_LABEL}</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : (
              <View style={s.unlockedRow}>
                <Feather name="check-circle" size={15} color={colors.green} />
                <Text style={s.unlockedText}>Full read unlocked</Text>
              </View>
            )}

            <Text style={s.ownerLabel}>VISIBILITY</Text>
            <View style={s.segment}>
              {([
                { key: "public", label: "Public", icon: "globe" },
                { key: "hidden", label: "Hidden", icon: "eye-off" },
                { key: "private", label: "Private", icon: "lock" },
              ] as const).map((opt) => {
                const active = (script.visibility ?? "public") === opt.key;
                const lockedOpt = opt.key === "private" && !script.full_read_unlocked;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[s.segItem, active && s.segItemActive]}
                    onPress={() => setVisibility(opt.key)}
                    disabled={busy}
                    activeOpacity={0.85}
                  >
                    <Feather
                      name={opt.icon as any}
                      size={13}
                      color={active ? "#fff" : lockedOpt ? colors.textMuted : colors.textSecondary}
                    />
                    <Text
                      style={[s.segText, active && s.segTextActive, lockedOpt && { color: colors.textMuted }]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={s.ownerHint}>
              {script.visibility === "private"
                ? "Only you and people you invite can find or open this script."
                : script.visibility === "hidden"
                ? "Hidden from Discover and Browse. Still reachable by direct link."
                : "Listed publicly in Discover and Browse."}
            </Text>

            {script.full_read_unlocked && script.visibility === "private" && (
              <View style={s.inviteBox}>
                <Text style={s.ownerLabel}>INVITE BY EMAIL</Text>
                <View style={s.inviteRow}>
                  <TextInput
                    style={s.inviteInput}
                    placeholder="name@email.com"
                    placeholderTextColor={colors.textMuted}
                    value={inviteEmail}
                    onChangeText={setInviteEmail}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    autoCorrect={false}
                    onSubmitEditing={addInvite}
                    returnKeyType="done"
                  />
                  <TouchableOpacity style={s.inviteAdd} onPress={addInvite} disabled={addingInvite} activeOpacity={0.85}>
                    {addingInvite ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Feather name="plus" size={18} color="#fff" />
                    )}
                  </TouchableOpacity>
                </View>
                {invites.map((inv) => (
                  <View key={inv.id} style={s.inviteItem}>
                    <Feather name="mail" size={13} color={colors.textSecondary} />
                    <Text style={s.inviteEmail} numberOfLines={1}>
                      {inv.email}
                    </Text>
                    <TouchableOpacity onPress={() => removeInvite(inv.id)} hitSlop={8}>
                      <Feather name="x" size={15} color={colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                ))}
                {invites.length === 0 && (
                  <Text style={s.ownerHint}>
                    No one invited yet. Add an email — they’ll get access when they sign in with it.
                  </Text>
                )}
              </View>
            )}

            <TouchableOpacity
              style={[s.ownerBtn, s.ownerBtnDanger, { marginTop: spacing.lg }]}
              onPress={confirmDelete}
              disabled={busy}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.red} />
              ) : (
                <Feather name="trash-2" size={15} color={colors.red} />
              )}
              <Text style={[s.ownerBtnText, { color: colors.red }]}>Delete screenplay</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Characters */}
        <View style={s.charsSection}>
          <View style={s.sectionHeader}>
            <View style={s.sectionAccent} />
            <Text style={s.sectionTitle}>Characters</Text>
          </View>

          {characters.map((char) => (
            <TouchableOpacity
              key={char.id}
              style={s.charCard}
              onPress={() => router.push(`/role/${char.id}` as any)}
              activeOpacity={0.8}
            >
              <View style={s.charRow}>
                <View style={s.charAvatar}>
                  <Text style={s.charInitial}>{char.name.charAt(0)}</Text>
                </View>
                <View style={s.charContent}>
                  <Text style={s.charName}>{char.name}</Text>
                  {char.description && (
                    <Text style={s.charDesc} numberOfLines={2}>
                      {char.description}
                    </Text>
                  )}
                  <View style={s.charMeta}>
                    <Text style={s.charMetaText}>{char.line_count} lines</Text>
                    <View style={s.metaDot} />
                    <Text style={s.charMetaText}>
                      {char.submission_count} submission
                      {char.submission_count !== 1 ? "s" : ""}
                    </Text>
                  </View>
                </View>
                <Feather name="chevron-right" size={18} color={colors.cardBorder} />
              </View>

              {isOpen && (
                <TouchableOpacity
                  style={s.auditionBtn}
                  onPress={() => {
                    if (!requireAuth("read for this role")) return;
                    router.push(`/recording/${char.id}` as any);
                  }}
                >
                  <Feather name="video" size={14} color={colors.primary} />
                  <Text style={s.auditionBtnText}>Read for this role</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  loadingContainer: {
    flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg,
  },
  container: { flex: 1, backgroundColor: colors.bg },
  coverImage: { width: "100%", height: 200 },
  posterEditBtn: {
    position: "absolute", bottom: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.full,
  },
  posterEditText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  posterAdd: {
    margin: spacing.xl, marginBottom: 0, height: 120, borderRadius: radius.xl,
    borderWidth: 2, borderStyle: "dashed", borderColor: colors.cardBorder,
    alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.card,
  },
  posterAddText: { color: colors.textMuted, fontSize: 13 },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  badgeRow: { flexDirection: "row", alignItems: "center", marginBottom: spacing.md, gap: 8 },
  genreBadge: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full },
  genreBadgeText: { fontSize: 12, fontWeight: "700" },
  statusBadge: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, gap: 6,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 12, fontWeight: "600" },
  title: { color: colors.text, fontSize: 28, fontWeight: "800", lineHeight: 34 },
  logline: { color: colors.textSecondary, fontSize: 15, marginTop: spacing.md, lineHeight: 22 },
  copyrightBadge: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6,
    backgroundColor: colors.greenMuted, paddingHorizontal: spacing.md, paddingVertical: 7,
    borderRadius: radius.full, marginTop: spacing.md,
  },
  copyrightBadgeText: { color: colors.green, fontSize: 12, fontWeight: "700" },
  actionRow: { flexDirection: "row", marginTop: spacing.xl, gap: spacing.md },
  statChip: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.card, paddingHorizontal: spacing.lg, paddingVertical: 10,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.cardBorder,
  },
  statChipText: { color: colors.text, fontSize: 14, fontWeight: "600", marginLeft: spacing.sm },
  readScriptBtn: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.primaryMuted, paddingHorizontal: spacing.lg, paddingVertical: 10,
    borderRadius: radius.md, gap: 8, borderWidth: 1, borderColor: "rgba(188, 64, 38,0.2)",
  },
  readScriptText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
  playAiBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.primary, borderRadius: radius.lg,
    paddingVertical: 14, marginTop: spacing.lg,
  },
  playAiText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  treatmentBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.card, borderRadius: radius.lg, paddingVertical: 13, marginTop: spacing.md,
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  treatmentBtnText: { color: colors.text, fontSize: 14, fontWeight: "700" },
  modRow: { flexDirection: "row", gap: spacing.xl, marginTop: spacing.lg },
  modBtn: { flexDirection: "row", alignItems: "center", gap: 5 },
  modText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  castingBtn: {
    marginHorizontal: spacing.xl, marginBottom: spacing.lg,
    backgroundColor: colors.primary, borderRadius: radius.xl,
    paddingVertical: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8,
  },
  castingBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  hiddenPill: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: colors.elevated, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full,
  },
  hiddenPillText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  ownerPanel: { marginHorizontal: spacing.xl, marginBottom: spacing.lg },
  unlockCard: {
    backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: "rgba(188, 64, 38,0.25)",
    borderRadius: radius.xl, padding: spacing.lg, marginBottom: spacing.lg,
  },
  unlockHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  unlockTitle: { color: colors.text, fontSize: 16, fontWeight: "800" },
  unlockBody: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: spacing.md },
  unlockBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.primary, borderRadius: radius.lg, paddingVertical: 13,
  },
  unlockBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  unlockedRow: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: spacing.lg },
  unlockedText: { color: colors.green, fontSize: 13, fontWeight: "700" },
  ownerLabel: {
    color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1.2, marginBottom: 8,
  },
  segment: {
    flexDirection: "row", backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
    borderRadius: radius.lg, padding: 4, gap: 4,
  },
  segItem: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: 9, borderRadius: radius.md,
  },
  segItemActive: { backgroundColor: colors.primary },
  segText: { color: colors.textSecondary, fontSize: 13, fontWeight: "700" },
  segTextActive: { color: "#fff" },
  ownerHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 8 },
  inviteBox: { marginTop: spacing.lg },
  inviteRow: { flexDirection: "row", gap: spacing.sm },
  inviteInput: {
    flex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
    borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: 12, color: colors.text, fontSize: 15,
  },
  inviteAdd: {
    width: 48, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.primary, borderRadius: radius.lg,
  },
  inviteItem: {
    flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
  },
  inviteEmail: { flex: 1, color: colors.text, fontSize: 14 },
  ownerBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.lg, paddingVertical: 13,
  },
  ownerBtnDanger: { borderColor: "rgba(168,47,28,0.4)" },
  ownerBtnText: { color: colors.text, fontSize: 14, fontWeight: "700" },
  charsSection: { paddingHorizontal: spacing.xl, marginTop: spacing.sm, paddingBottom: 40 },
  sectionHeader: { flexDirection: "row", alignItems: "center", marginBottom: spacing.lg },
  sectionAccent: { width: 4, height: 20, backgroundColor: colors.primary, borderRadius: radius.full, marginRight: 10 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  charCard: {
    backgroundColor: colors.card, borderRadius: radius.xl, padding: spacing.xl,
    marginBottom: spacing.md, borderWidth: 1, borderColor: colors.cardBorder,
  },
  charRow: { flexDirection: "row", alignItems: "flex-start" },
  charAvatar: {
    width: 44, height: 44, borderRadius: radius.md,
    backgroundColor: colors.primaryMuted, alignItems: "center", justifyContent: "center",
    marginRight: spacing.md, marginTop: 2,
  },
  charInitial: { color: colors.primary, fontWeight: "700", fontSize: 16 },
  charContent: { flex: 1 },
  charName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  charDesc: { color: colors.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 18 },
  charMeta: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  charMetaText: { color: colors.textMuted, fontSize: 12 },
  metaDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.cardBorder, marginHorizontal: spacing.sm },
  auditionBtn: {
    marginTop: spacing.lg, backgroundColor: colors.primaryMuted,
    borderRadius: radius.md, paddingVertical: 10, alignItems: "center",
    borderWidth: 1, borderColor: "rgba(188, 64, 38,0.2)",
    flexDirection: "row", justifyContent: "center", gap: 8,
  },
  auditionBtnText: { color: colors.primary, fontWeight: "700", fontSize: 14 },
});
