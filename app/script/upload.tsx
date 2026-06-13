import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Feather } from "@expo/vector-icons";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { uploadFile } from "@/lib/storage";
import { GENRES } from "@/lib/constants";
import { colors, radius, spacing } from "@/lib/theme";

export default function UploadScriptScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState<string>(GENRES[0]);
  const [logline, setLogline] = useState("");
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [coverImage, setCoverImage] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [copyrightDoc, setCopyrightDoc] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [regNumber, setRegNumber] = useState("");
  const [treatmentDoc, setTreatmentDoc] = useState<DocumentPicker.DocumentPickerAsset | null>(null);

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "text/plain", "application/xml", "text/xml", "*/*"],
      copyToCacheDirectory: true,
    });
    if (!result.canceled && result.assets.length > 0) {
      setFile(result.assets[0]);
    }
  }

  async function pickCoverImage() {
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
    if (!result.canceled && result.assets.length > 0) {
      setCoverImage(result.assets[0]);
    }
  }

  async function pickCopyrightDoc() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/*"],
      copyToCacheDirectory: true,
    });
    if (!result.canceled && result.assets.length > 0) {
      setCopyrightDoc(result.assets[0]);
    }
  }

  async function pickTreatment() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf"],
      copyToCacheDirectory: true,
    });
    if (!result.canceled && result.assets.length > 0) {
      setTreatmentDoc(result.assets[0]);
    }
  }

  async function handleUpload() {
    if (!title || !logline || !file || !session) {
      Alert.alert("Error", "Please fill in all fields and select a PDF.");
      return;
    }
    if (!agreed) {
      Alert.alert("Confirm rights", "Please confirm you have the rights to this screenplay before uploading.");
      return;
    }

    setUploading(true);
    try {
      // Upload PDF
      const ext = file.name.split(".").pop() ?? "pdf";
      const storagePath = `${session.user.id}/${Date.now()}.${ext}`;
      await uploadFile("scripts", storagePath, file.uri, "application/pdf", setUploadProgress);

      // Upload cover image if selected
      let coverImageUrl: string | null = null;
      if (coverImage) {
        const imgExt = coverImage.uri.split(".").pop() ?? "jpg";
        const imgPath = `${session.user.id}/${Date.now()}-cover.${imgExt}`;
        await uploadFile("avatars", imgPath, coverImage.uri, `image/${imgExt}`);
        const { data } = supabase.storage.from("avatars").getPublicUrl(imgPath);
        coverImageUrl = data.publicUrl;
      }

      // Optional copyright/registration document → private scripts bucket
      let copyrightDocUrl: string | null = null;
      if (copyrightDoc) {
        const cExt = (copyrightDoc.name?.split(".").pop() || "pdf").toLowerCase();
        const cPath = `${session.user.id}/copyright/${Date.now()}.${cExt}`;
        await uploadFile("scripts", cPath, copyrightDoc.uri, copyrightDoc.mimeType || "application/pdf");
        copyrightDocUrl = cPath;
      }

      // Optional treatment PDF → private scripts bucket
      let treatmentUrl: string | null = null;
      if (treatmentDoc) {
        const tPath = `${session.user.id}/treatment/${Date.now()}.pdf`;
        await uploadFile("scripts", tPath, treatmentDoc.uri, treatmentDoc.mimeType || "application/pdf");
        treatmentUrl = tPath;
      }

      // No expiration — set far-future deadline
      const deadline = new Date("2099-12-31");

      const { data: scriptData, error: insertError } = await supabase
        .from("scripts")
        .insert({
          writer_id: session.user.id,
          title: title.trim(),
          genre,
          logline: logline.trim(),
          file_url: storagePath,
          cover_image_url: coverImageUrl,
          status: "open",
          submission_deadline: deadline.toISOString(),
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // Record the rights attestation + any copyright doc/registration
      // (best-effort; harmless no-op if those columns haven't been added yet).
      void supabase
        .from("scripts")
        .update({
          rights_acknowledged_at: new Date().toISOString(),
          copyright_doc_url: copyrightDocUrl,
          copyright_reg_number: regNumber.trim() || null,
          treatment_url: treatmentUrl,
        })
        .eq("id", scriptData.id);

      // Trigger PDF parsing edge function
      const { error: fnError } = await supabase.functions.invoke("parse-script", {
        body: { script_id: scriptData.id },
      });
      if (fnError) console.warn("Parse function error (non-blocking):", fnError);

      router.replace(`/script/${scriptData.id}` as any);
    } catch (error: any) {
      Alert.alert("Upload Failed", error.message);
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: "Upload Script",
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: "#fff",
        }}
      />
      <ScrollView style={s.container} contentContainerStyle={{ padding: spacing.xxl }}>
        {/* Cover Image */}
        <View style={s.fieldGroup}>
          <Text style={s.label}>COVER IMAGE (OPTIONAL)</Text>
          <TouchableOpacity style={s.coverPicker} onPress={pickCoverImage} activeOpacity={0.8}>
            {coverImage ? (
              <Image source={{ uri: coverImage.uri }} style={s.coverPreview} />
            ) : (
              <View style={s.coverPlaceholder}>
                <Feather name="image" size={32} color={colors.textMuted} />
                <Text style={s.coverPlaceholderText}>Tap to add a cover image</Text>
                <Text style={s.coverPlaceholderHint}>16:9 recommended</Text>
              </View>
            )}
            {coverImage && (
              <TouchableOpacity
                style={s.coverRemove}
                onPress={() => setCoverImage(null)}
              >
                <Feather name="x" size={16} color="#fff" />
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        </View>

        {/* Title */}
        <View style={s.fieldGroup}>
          <Text style={s.label}>TITLE</Text>
          <TextInput
            style={s.input}
            placeholder="My Script Title"
            placeholderTextColor={colors.textMuted}
            value={title}
            onChangeText={setTitle}
          />
        </View>

        {/* Genre */}
        <View style={s.fieldGroup}>
          <Text style={s.label}>GENRE</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {GENRES.map((g) => (
              <TouchableOpacity
                key={g}
                style={[s.genreChip, genre === g ? s.genreActive : s.genreInactive]}
                onPress={() => setGenre(g)}
              >
                <Text style={genre === g ? s.genreTextActive : s.genreTextInactive}>
                  {g}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Logline */}
        <View style={s.fieldGroup}>
          <Text style={s.label}>LOGLINE</Text>
          <TextInput
            style={[s.input, { minHeight: 80, textAlignVertical: "top" }]}
            placeholder="A brief summary of your script..."
            placeholderTextColor={colors.textMuted}
            value={logline}
            onChangeText={setLogline}
            multiline
            numberOfLines={3}
          />
        </View>

        {/* PDF Picker */}
        <TouchableOpacity style={s.filePicker} onPress={pickFile}>
          <Feather name="file-text" size={28} color={file ? colors.primary : colors.textMuted} />
          <Text style={[s.filePickerText, file && { color: colors.text }]}>
            {file ? file.name : "Tap to select script"}
          </Text>
        </TouchableOpacity>

        {/* Treatment (optional) */}
        <View style={s.fieldGroup}>
          <Text style={s.label}>TREATMENT (OPTIONAL)</Text>
          <TouchableOpacity style={s.docPicker} onPress={pickTreatment} activeOpacity={0.8}>
            <Feather
              name={treatmentDoc ? "check-circle" : "file-text"}
              size={20}
              color={treatmentDoc ? colors.green : colors.textMuted}
            />
            <Text style={[s.docPickerText, treatmentDoc && { color: colors.text }]} numberOfLines={1}>
              {treatmentDoc ? treatmentDoc.name : "Attach a treatment PDF — many producers read this first"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Copyright / registration (optional) */}
        <View style={s.fieldGroup}>
          <Text style={s.label}>COPYRIGHT / REGISTRATION (OPTIONAL)</Text>
          <TouchableOpacity style={s.docPicker} onPress={pickCopyrightDoc} activeOpacity={0.8}>
            <Feather
              name={copyrightDoc ? "check-circle" : "shield"}
              size={20}
              color={copyrightDoc ? colors.green : colors.textMuted}
            />
            <Text style={[s.docPickerText, copyrightDoc && { color: colors.text }]} numberOfLines={1}>
              {copyrightDoc ? copyrightDoc.name : "Attach copyright or WGA registration (PDF / image)"}
            </Text>
          </TouchableOpacity>
          <TextInput
            style={[s.input, { marginTop: 8 }]}
            placeholder="Registration number (optional)"
            placeholderTextColor={colors.textMuted}
            value={regNumber}
            onChangeText={setRegNumber}
            autoCapitalize="characters"
          />
          <Text style={s.docHint}>
            Scripts with copyright on file get a badge — many directors look for it before reading.
          </Text>
        </View>

        {/* Progress */}
        {uploading && (
          <View style={s.progressContainer}>
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${uploadProgress * 100}%` }]} />
            </View>
            <Text style={s.progressText}>
              Uploading... {Math.round(uploadProgress * 100)}%
            </Text>
          </View>
        )}

        {/* Rights attestation — required before upload */}
        <TouchableOpacity style={s.agreeRow} onPress={() => setAgreed(!agreed)} activeOpacity={0.7}>
          <View style={[s.checkbox, agreed && s.checkboxOn]}>
            {agreed && <Feather name="check" size={14} color="#fff" />}
          </View>
          <Text style={s.agreeText}>
            I confirm I own or control all rights to this screenplay, that it doesn't infringe
            anyone else's copyright, and I accept responsibility for what I upload.
          </Text>
        </TouchableOpacity>

        {/* Submit */}
        <TouchableOpacity
          style={[s.submitBtn, (uploading || !agreed) && s.submitBtnDisabled]}
          onPress={handleUpload}
          disabled={uploading || !agreed}
          activeOpacity={0.85}
        >
          {uploading ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={s.submitBtnText}>Upload & Parse</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  fieldGroup: { marginBottom: spacing.xl },
  fieldGroupLarge: { marginBottom: spacing.xxl },
  label: {
    color: colors.textSecondary, fontSize: 11, fontWeight: "700",
    letterSpacing: 1.5, marginBottom: 8, marginLeft: 4,
  },
  input: {
    borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.xl,
    paddingHorizontal: 20, paddingVertical: 16, fontSize: 16,
    backgroundColor: colors.card, color: colors.text,
  },
  coverPicker: {
    borderRadius: radius.xl, overflow: "hidden",
    borderWidth: 1, borderColor: colors.cardBorder, backgroundColor: colors.card,
  },
  coverPreview: { width: "100%", height: 180, borderRadius: radius.xl },
  coverPlaceholder: {
    height: 140, alignItems: "center", justifyContent: "center",
  },
  coverPlaceholderText: { color: colors.textSecondary, marginTop: 8, fontSize: 14 },
  coverPlaceholderHint: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  coverRemove: {
    position: "absolute", top: 10, right: 10, width: 28, height: 28,
    borderRadius: 14, backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center", justifyContent: "center",
  },
  genreChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.full, marginRight: 8 },
  genreActive: { backgroundColor: colors.primary },
  genreInactive: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder },
  genreTextActive: { color: "#fff", fontWeight: "600" },
  genreTextInactive: { color: colors.textSecondary },
  filePicker: {
    borderWidth: 2, borderStyle: "dashed", borderColor: colors.cardBorder,
    borderRadius: radius.xl, padding: 32, alignItems: "center", marginBottom: spacing.xxl,
  },
  filePickerText: { color: colors.textSecondary, marginTop: 8, fontSize: 14 },
  docPicker: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.xl,
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: colors.card,
  },
  docPickerText: { flex: 1, color: colors.textSecondary, fontSize: 14 },
  docHint: { color: colors.textMuted, fontSize: 12, marginTop: 8, marginLeft: 4, lineHeight: 17 },
  progressContainer: { marginBottom: spacing.lg },
  progressTrack: { height: 6, backgroundColor: colors.cardBorder, borderRadius: radius.full, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: colors.primary, borderRadius: radius.full },
  progressText: { fontSize: 12, color: colors.textMuted, textAlign: "center", marginTop: 4 },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: spacing.lg, paddingHorizontal: 4 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.cardBorder,
    alignItems: "center", justifyContent: "center", marginTop: 1,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  agreeText: { flex: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  submitBtn: { backgroundColor: colors.primary, borderRadius: radius.xl, paddingVertical: 16, alignItems: "center" },
  submitBtnDisabled: { backgroundColor: colors.cardBorder },
  submitBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
