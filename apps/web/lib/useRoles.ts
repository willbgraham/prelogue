"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

/**
 * Current user's roles (writer / actor / audience) for client-side gating.
 * `addRole` is the self-serve "enable this role" action used by the soft gates.
 * While `loading` (or logged-out → `userId` null), callers should not gate.
 */
export function useRoles() {
  const supabase = getBrowserClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!alive) return;
      if (!user) {
        setLoading(false);
        return;
      }
      setUserId(user.id);
      const { data } = await supabase.from("users").select("roles").eq("id", user.id).single();
      if (!alive) return;
      setRoles(((data?.roles as string[]) ?? []).filter(Boolean));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [supabase]);

  const addRole = useCallback(
    async (r: string) => {
      if (!userId) return;
      const next = Array.from(new Set([...roles, r]));
      setRoles(next);
      await supabase.from("users").update({ roles: next }).eq("id", userId);
    },
    [userId, roles, supabase]
  );

  const has = (r: string) => roles.includes(r);
  return { userId, roles, loading, addRole, has };
}
