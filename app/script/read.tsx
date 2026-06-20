import { useEffect, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { WebView } from "react-native-webview";
import { supabase } from "@/lib/supabase";
import { getSignedUrl } from "@/lib/storage";
import { colors } from "@/lib/theme";

export default function ReadScriptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [title, setTitle] = useState("Script");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPdf();
  }, [id]);

  async function loadPdf() {
    const { data } = await supabase
      .from("scripts")
      .select("title, file_url")
      .eq("id", id)
      .single();

    if (data) {
      setTitle(data.title);
      try {
        const url = await getSignedUrl("scripts", data.file_url, 3600);
        setPdfUrl(url);
      } catch (err) {
        console.error("Failed to get PDF URL:", err);
      }
    }
    setLoading(false);
  }

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerStyle: { backgroundColor: "#ffffff" },
          headerTintColor: "#000000",
          headerTitleStyle: { fontWeight: "700" },
        }}
      />
      <View style={s.container}>
        {loading ? (
          <View style={s.loadingWrap}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : !pdfUrl ? (
          <View style={s.loadingWrap}>
            <Text style={s.emptyText}>The script PDF isn't available for this title.</Text>
          </View>
        ) : (
          <WebView
            source={{
              uri: `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(pdfUrl)}`,
            }}
            style={s.webview}
            startInLoadingState
            renderLoading={() => (
              <View style={s.webviewLoading}>
                <ActivityIndicator size="large" color={colors.primary} />
              </View>
            )}
          />
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  webview: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  webviewLoading: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  emptyText: { color: "#2A2420", fontSize: 15, textAlign: "center", paddingHorizontal: 32 },
});
