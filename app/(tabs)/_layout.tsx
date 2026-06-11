import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { View, StyleSheet } from "react-native";
import { colors } from "@/lib/theme";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg, elevation: 0, shadowOpacity: 0 },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "700", fontSize: 18 },
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.elevated,
          borderTopWidth: 1,
          height: 88,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", marginTop: 2 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Discover",
          headerShown: false,
          tabBarIcon: ({ color, focused }) => (
            <View style={[s.iconWrap, focused && s.iconFocused]}>
              <Feather name="compass" size={22} color={color} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="scripts"
        options={{
          title: "Scripts",
          tabBarIcon: ({ color, focused }) => (
            <View style={[s.iconWrap, focused && s.iconFocused]}>
              <Feather name="book-open" size={22} color={color} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="leaderboard"
        options={{
          title: "Rankings",
          tabBarIcon: ({ color, focused }) => (
            <View style={[s.iconWrap, focused && s.iconFocused]}>
              <Feather name="award" size={22} color={color} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, focused }) => (
            <View style={[s.iconWrap, focused && s.iconFocused]}>
              <Feather name="user" size={22} color={color} />
            </View>
          ),
        }}
      />
      {/* Hidden tabs — accessible via navigation, not shown in tab bar */}
      <Tabs.Screen name="record" options={{ href: null }} />
      <Tabs.Screen name="notifications" options={{ href: null }} />
    </Tabs>
  );
}

const s = StyleSheet.create({
  iconWrap: { padding: 6, borderRadius: 12 },
  iconFocused: { backgroundColor: "rgba(108, 92, 231, 0.15)" },
});
