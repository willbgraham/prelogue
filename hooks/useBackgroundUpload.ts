import { useState, useRef, useCallback } from "react";
import { AppState, AppStateStatus } from "react-native";
import { Upload } from "tus-js-client";

interface UploadState {
  progress: number;
  isUploading: boolean;
  error: string | null;
  completed: boolean;
}

/**
 * Background-aware video upload hook using TUS resumable protocol.
 * Continues uploading when app goes to background and auto-resumes
 * if the upload was interrupted.
 */
export function useBackgroundUpload() {
  const [state, setState] = useState<UploadState>({
    progress: 0,
    isUploading: false,
    error: null,
    completed: false,
  });
  const uploadRef = useRef<Upload | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const startUpload = useCallback(
    (
      bucket: string,
      path: string,
      fileUri: string,
      accessToken: string,
      onComplete?: () => void
    ) => {
      setState({ progress: 0, isUploading: true, error: null, completed: false });

      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;

      const upload = new Upload(
        { uri: fileUri } as any,
        {
          endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
          retryDelays: [0, 1000, 3000, 5000, 10000, 30000],
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
          chunkSize: 6 * 1024 * 1024,
          onError: (error) => {
            console.error("Upload error:", error);
            setState((prev) => ({
              ...prev,
              isUploading: false,
              error: error.message || "Upload failed",
            }));
          },
          onProgress: (bytesUploaded, bytesTotal) => {
            const pct = bytesUploaded / bytesTotal;
            setState((prev) => ({ ...prev, progress: pct }));
          },
          onSuccess: () => {
            setState({
              progress: 1,
              isUploading: false,
              error: null,
              completed: true,
            });
            onComplete?.();
          },
        }
      );

      uploadRef.current = upload;

      // Handle app state changes — pause/resume upload
      const subscription = AppState.addEventListener(
        "change",
        (nextState: AppStateStatus) => {
          if (
            appStateRef.current.match(/active/) &&
            nextState === "background"
          ) {
            // App going to background — TUS will handle retries
            console.log("Upload continuing in background...");
          }
          if (
            appStateRef.current.match(/background|inactive/) &&
            nextState === "active"
          ) {
            // App coming back — check if upload needs resuming
            if (uploadRef.current && state.isUploading) {
              console.log("Resuming upload...");
              uploadRef.current.start();
            }
          }
          appStateRef.current = nextState;
        }
      );

      upload.start();

      return () => {
        subscription.remove();
      };
    },
    []
  );

  const cancelUpload = useCallback(() => {
    if (uploadRef.current) {
      uploadRef.current.abort();
      uploadRef.current = null;
    }
    setState({ progress: 0, isUploading: false, error: null, completed: false });
  }, []);

  return {
    ...state,
    startUpload,
    cancelUpload,
  };
}
