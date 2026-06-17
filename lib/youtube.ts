import * as WebBrowser from "expo-web-browser";
import { Alert } from "react-native";
import { supabase } from "./supabase";

/**
 * YouTube export flow for assembled table reads.
 *
 * In a full implementation, this would:
 * 1. Authenticate with YouTube Data API v3 via OAuth
 * 2. Upload the video file to YouTube
 * 3. Set title, description, tags
 * 4. Store the YouTube URL in assembled_reads.youtube_url
 *
 * For now, this opens a share flow where the user can manually
 * upload from their device after downloading the video.
 */

export async function exportToYouTube(
  assembledReadId: string,
  scriptTitle: string,
  genre: string,
  castNames: string[]
) {
  // Check if video is available
  const { data: read } = await supabase
    .from("assembled_reads")
    .select("video_url, youtube_url")
    .eq("id", assembledReadId)
    .single();

  if (!read?.video_url) {
    Alert.alert("Not Ready", "The video hasn't been assembled yet.");
    return;
  }

  if (read.youtube_url) {
    Alert.alert(
      "Already Exported",
      "This table read has already been uploaded to YouTube.",
      [
        { text: "Open on YouTube", onPress: () => WebBrowser.openBrowserAsync(read.youtube_url!) },
        { text: "OK" },
      ]
    );
    return;
  }

  // Generate YouTube metadata
  const title = `${scriptTitle} — Table Read | Prelogue`;
  const description = [
    `Table read of "${scriptTitle}" (${genre})`,
    "",
    "Cast:",
    ...castNames.map((name, i) => `  ${i + 1}. ${name}`),
    "",
    "Created with Prelogue — the platform for screenwriters and actors.",
    "https://prelogue.app",
  ].join("\n");
  const tags = [genre, "table read", "screenplay", "acting", "prelogue", scriptTitle]
    .join(",");

  // For full implementation, use YouTube Data API:
  // const youtube = google.youtube('v3');
  // await youtube.videos.insert({ ... });

  // For now, open YouTube Studio in browser
  Alert.alert(
    "Export to YouTube",
    `Ready to export "${scriptTitle}" to YouTube.\n\nTitle: ${title}\n\nThis will open YouTube Studio where you can upload the video.`,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Open YouTube Studio",
        onPress: () => WebBrowser.openBrowserAsync("https://studio.youtube.com/"),
      },
    ]
  );
}
