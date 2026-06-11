import { supabase } from "./supabase";
import * as FileSystem from "expo-file-system";
import { Upload } from "tus-js-client";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;

/**
 * Upload a file to Supabase Storage (standard upload for small files like PDFs).
 */
export async function uploadFile(
  bucket: string,
  path: string,
  fileUri: string,
  contentType: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  const fileInfo = await FileSystem.getInfoAsync(fileUri);
  if (!fileInfo.exists) throw new Error("File not found");

  const base64 = await FileSystem.readAsStringAsync(fileUri, {
    encoding: "base64" as const,
  });

  const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

  onProgress?.(0.5);

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, byteArray, { contentType, upsert: false });

  if (error) throw error;

  onProgress?.(1);
  return path;
}

/**
 * Upload a video file using TUS resumable protocol for progress tracking and resilience.
 */
export function uploadVideoResumable(
  bucket: string,
  path: string,
  fileUri: string,
  accessToken: string,
  onProgress?: (progress: number) => void,
  onSuccess?: () => void,
  onError?: (error: Error) => void
): { upload: Upload; abort: () => void } {
  const upload = new Upload(
    {
      uri: fileUri,
      // tus-js-client accepts a file-like object with uri for React Native
    } as any,
    {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-upsert": "false",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: "video/mp4",
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024, // 6MB chunks
      onError: (error) => {
        console.error("Upload error:", error);
        onError?.(error as Error);
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const percentage = bytesUploaded / bytesTotal;
        onProgress?.(percentage);
      },
      onSuccess: () => {
        onSuccess?.();
      },
    }
  );

  upload.start();

  return {
    upload,
    abort: () => upload.abort(),
  };
}

/**
 * Get a signed URL for a file in a private bucket.
 */
export async function getSignedUrl(
  bucket: string,
  path: string,
  expiresIn: number = 3600
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Get a public URL for a file in a public bucket.
 */
export function getPublicUrl(bucket: string, path: string): string {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}
