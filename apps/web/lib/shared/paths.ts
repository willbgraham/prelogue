// Storage path schemes — single source shared by mobile + web so audio/clip
// objects line up across both apps. Must match generate-voice-cues (audio +
// manifest, `scripts` bucket) and the recorder (clips, `submissions` bucket).

/** Content-addressed TTS audio in the private `scripts` bucket. */
export function audioPath(voiceId: string, sha1OfNormalizedText: string): string {
  return `voice-cues/audio/${voiceId}/${sha1OfNormalizedText}.mp3`;
}

/** Per-(script, voiceConfigHash) manifest in the `scripts` bucket. */
export function manifestPath(scriptId: string, voiceConfigHash: string): string {
  return `voice-cues/script/${scriptId}/${voiceConfigHash}/manifest.json`;
}

/**
 * Per-line actor clip in the private `submissions` bucket.
 * `{userId}/{scriptId}/{characterId}/t{take}/e{paddedElementIndex}.{ext}`.
 * Mobile records .mp4; web MediaRecorder may produce .webm — pass the real ext.
 */
export function clipPath(
  userId: string,
  scriptId: string,
  characterId: string,
  takeNumber: number,
  elementIndex: number,
  ext = "mp4"
): string {
  const idx = String(elementIndex).padStart(5, "0");
  return `${userId}/${scriptId}/${characterId}/t${takeNumber}/e${idx}.${ext}`;
}
