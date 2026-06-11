import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { supabase } from "./supabase";
import { router } from "expo-router";

// Configure how notifications appear when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Register for push notifications and store the token in Supabase.
 * Fails silently — push is optional and should never block auth.
 */
export async function registerForPushNotifications(userId: string) {
  try {
    if (!Device.isDevice) {
      console.log("Push notifications require a physical device");
      return;
    }

    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.log("Push notification permission not granted");
      return;
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      console.log("No EAS projectId configured — skipping push token registration");
      return;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData.data;

    // Store in Supabase (upsert to avoid duplicates)
    await supabase.from("push_tokens").upsert(
      {
        user_id: userId,
        token,
        platform: Platform.OS,
      },
      { onConflict: "user_id,token" }
    );

    console.log("Push token registered:", token);
  } catch (err) {
    // Never let push registration crash the app
    console.warn("Push token registration failed (non-fatal):", err);
  }
}

/**
 * Set up notification tap handler for navigation.
 */
export function setupNotificationHandlers() {
  // Handle notification tapped while app is running
  const subscription = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const data = response.notification.request.content.data ?? {};
      navigateFromNotification(data as Record<string, unknown>);
    }
  );

  return () => subscription.remove();
}

function navigateFromNotification(data: Record<string, unknown>) {
  if (data.script_id) {
    router.push(`/script/${data.script_id}` as any);
  } else if (data.assembled_read_id) {
    router.push(`/table-read/${data.assembled_read_id}` as any);
  }
}
