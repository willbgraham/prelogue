import * as tus from "tus-js-client";

/**
 * Resumable upload of a recorded clip Blob to the private `submissions` bucket,
 * via Supabase storage's TUS endpoint. Presents the user's access token so
 * storage RLS authorizes the write (same contract as the mobile recorder).
 */
export function uploadClipResumable(
  blob: Blob,
  objectPath: string,
  accessToken: string,
  contentType: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(blob, {
      endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-upsert": "false",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: "submissions",
        objectName: objectPath,
        contentType,
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024,
      onError: (e) => reject(e),
      onProgress: (sent, total) => onProgress?.(total ? sent / total : 0),
      onSuccess: () => resolve(),
    });
    upload.start();
  });
}
