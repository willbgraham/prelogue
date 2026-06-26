import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";

export async function AuthNav() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <Link
        href="/sign-in"
        className="rounded-lg border border-tan px-4 py-2 text-sm font-medium hover:bg-ivory"
      >
        Sign in
      </Link>
    );
  }

  const { data: profile } = await supabase
    .from("users")
    .select("username, display_name")
    .eq("id", user.id)
    .single();
  const name =
    profile?.display_name || (user.user_metadata?.display_name as string) || user.email;
  return (
    <div className="flex items-center gap-3">
      <Link href="/studio" className="text-sm font-medium hover:text-brick">
        Studio
      </Link>
      {profile?.username ? (
        <Link
          href={`/u/${profile.username}`}
          className="hidden text-sm text-taupe hover:text-brick sm:inline"
        >
          {name}
        </Link>
      ) : (
        <span className="hidden text-sm text-taupe sm:inline">{name}</span>
      )}
      <form action={signOut}>
        <button className="rounded-lg border border-tan px-3 py-2 text-sm hover:bg-ivory">
          Sign out
        </button>
      </form>
    </div>
  );
}
