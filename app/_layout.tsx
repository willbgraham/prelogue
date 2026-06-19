import "../global.css";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AppErrorBoundary } from "@/components/ErrorBoundary";
import { colors } from "@/lib/theme";
import {
  registerForPushNotifications,
  setupNotificationHandlers,
} from "@/lib/notifications";

export { ErrorBoundary } from "expo-router";

SplashScreen.preventAutoHideAsync();

const appHeader = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.bg },
  headerTintColor: colors.text,
  headerTitleStyle: { fontWeight: "700" as const },
};

function RootLayoutNav() {
  const { session, profile } = useAuth();

  useEffect(() => {
    if (session?.user?.id && profile?.role) {
      registerForPushNotifications(session.user.id);
    }
  }, [session?.user?.id, profile?.role]);

  useEffect(() => {
    const cleanup = setupNotificationHandlers();
    return cleanup;
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="script" />
        <Stack.Screen name="role" />
        <Stack.Screen name="recording" />
        <Stack.Screen name="casting" />
        <Stack.Screen name="table-read" />
        <Stack.Screen name="actor" />
        <Stack.Screen
          name="settings"
          options={{ ...appHeader, presentation: "modal", title: "Settings" }}
        />
        <Stack.Screen name="+not-found" options={appHeader} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) return null;

  return (
    <AppErrorBoundary>
      <AuthProvider>
        <RootLayoutNav />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
