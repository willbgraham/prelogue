import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import type { User } from "../lib/types";

interface AuthStore {
  session: Session | null;
  profile: User | null;
  setSession: (session: Session | null) => void;
  setProfile: (profile: User | null) => void;
  isOnboarded: () => boolean;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  profile: null,
  setSession: (session) => set({ session }),
  setProfile: (profile) => set({ profile }),
  isOnboarded: () => {
    const profile = get().profile;
    return !!profile?.role;
  },
}));
