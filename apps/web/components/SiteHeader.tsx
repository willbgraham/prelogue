import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { HeaderNav } from "@/components/HeaderNav";

/**
 * Shared site header — wordmark (home) + responsive nav + auth controls.
 * Fetches the signed-in user here so the client nav can render auth state.
 */
export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let navUser: { name: string; username: string | null } | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("users")
      .select("username, display_name")
      .eq("id", user.id)
      .single();
    navUser = {
      name:
        profile?.display_name ||
        (user.user_metadata?.display_name as string) ||
        user.email ||
        "Account",
      username: profile?.username ?? null,
    };
  }

  return (
    <header className="flex items-center gap-x-4">
      <Link href="/" className="flex items-center gap-3">
        <Image
          src="/app-icon.png"
          alt="Prelogue Studio"
          width={40}
          height={40}
          priority
          className="h-10 w-10 rounded-[10px] border border-tan"
        />
        <span className="font-slab text-xl">Prelogue Studio</span>
      </Link>
      <HeaderNav user={navUser} />
    </header>
  );
}
