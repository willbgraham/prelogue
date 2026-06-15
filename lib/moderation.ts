import { Alert } from "react-native";
import { supabase } from "./supabase";

export type ReportKind = "submission" | "script" | "user";

const REASONS = [
  "Inappropriate or offensive",
  "Spam or misleading",
  "Copyright / impersonation",
  "Other",
];

async function currentUserId(): Promise<string | null> {
  return (await supabase.auth.getSession()).data.session?.user?.id ?? null;
}

/** Show a reason picker and file a content report. */
export function reportContent(kind: ReportKind, targetId: string) {
  Alert.alert(
    `Report this ${kind}`,
    "Why are you reporting it? We review reports and remove content that violates our rules.",
    [
      ...REASONS.map((reason) => ({
        text: reason,
        onPress: async () => {
          const uid = await currentUserId();
          if (!uid) return;
          await supabase
            .from("content_reports")
            .insert({ reporter_id: uid, kind, target_id: targetId, reason });
          Alert.alert("Thanks for reporting", "Our team will review this shortly.");
        },
      })),
      { text: "Cancel", style: "cancel" as const },
    ]
  );
}

/** Block a user (hides their content from the viewer). Calls onDone after. */
export function blockUser(blockedId: string, displayName: string, onDone?: () => void) {
  Alert.alert(`Block ${displayName}?`, "You won't see their scripts or reads anymore.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Block",
      style: "destructive",
      onPress: async () => {
        const uid = await currentUserId();
        if (!uid || uid === blockedId) return;
        await supabase
          .from("user_blocks")
          .upsert({ blocker_id: uid, blocked_id: blockedId }, { onConflict: "blocker_id,blocked_id" });
        onDone?.();
      },
    },
  ]);
}

/** The set of user ids the current viewer has blocked (empty if unauthed). */
export async function getBlockedIds(): Promise<Set<string>> {
  try {
    const uid = await currentUserId();
    if (!uid) return new Set();
    const { data } = await supabase.from("user_blocks").select("blocked_id").eq("blocker_id", uid);
    return new Set((data ?? []).map((r: any) => r.blocked_id as string));
  } catch {
    return new Set();
  }
}
