import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";

const ELEVENLABS_API_KEY = process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY;
const BASE_URL = "https://api.elevenlabs.io/v1";

// Default voices mapped to character archetypes
const VOICE_MAP: Record<string, string> = {
  male_default: "pNInz6obpgDQGcFmaJgB", // Adam
  female_default: "EXAVITQu4vr4xnSDxMaL", // Bella
  male_gruff: "VR6AewLTigWG4xSOukaG", // Arnold
  female_young: "jBpfuIE2acCO8z3wKNLl", // Gigi
  narrator: "onwK4e9ZLuTAKqWW03F9", // Daniel
};

/**
 * Generate AI voice audio for a character's cue lines.
 * Returns local file URI of the generated audio.
 */
export async function generateVoiceCue(
  text: string,
  voiceType: string = "male_default"
): Promise<string | null> {
  if (!ELEVENLABS_API_KEY) {
    console.log("ElevenLabs API key not configured — skipping voice cue");
    return null;
  }

  const voiceId = VOICE_MAP[voiceType] || VOICE_MAP.male_default;

  try {
    const response = await fetch(`${BASE_URL}/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      console.error("ElevenLabs error:", response.status);
      return null;
    }

    // Save to local file
    const audioDir = `${(FileSystem as any).cacheDirectory}voice-cues/`;
    await FileSystem.makeDirectoryAsync(audioDir, { intermediates: true });
    const filePath = `${audioDir}cue-${Date.now()}.mp3`;

    const blob = await response.blob();
    const reader = new FileReader();
    const base64 = await new Promise<string>((resolve) => {
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1]);
      };
      reader.readAsDataURL(blob);
    });

    await FileSystem.writeAsStringAsync(filePath, base64, {
      encoding: "base64" as any,
    });

    return filePath;
  } catch (err) {
    console.error("Voice cue generation failed:", err);
    return null;
  }
}

/**
 * Pre-generate all voice cues for non-actor lines in a scene.
 * Returns an array of { startIndex, audioUri } pairs.
 */
export async function preGenerateSceneCues(
  sceneElements: { type: string; character_name?: string; text: string }[],
  actorCharacterName: string
): Promise<{ index: number; audioUri: string }[]> {
  const cues: { index: number; audioUri: string }[] = [];

  for (let i = 0; i < sceneElements.length; i++) {
    const el = sceneElements[i];
    if (
      el.type === "dialogue" &&
      el.character_name &&
      el.character_name.toUpperCase() !== actorCharacterName.toUpperCase()
    ) {
      const uri = await generateVoiceCue(el.text);
      if (uri) {
        cues.push({ index: i, audioUri: uri });
      }
    }
  }

  return cues;
}

/**
 * Play a voice cue audio file.
 */
export async function playVoiceCue(uri: string): Promise<Audio.Sound> {
  const { sound } = await Audio.Sound.createAsync(
    { uri },
    { shouldPlay: true }
  );
  return sound;
}
