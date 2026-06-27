"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

type Comment = {
  id: string;
  body: string;
  created_at: string;
  user: { display_name: string; username: string | null; avatar_url: string | null } | null;
};

export function ReadComments({ readId }: { readId: string }) {
  const supabase = getBrowserClient();
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("comments")
      .select(
        "id, body, created_at, user:users!comments_user_id_fkey(display_name, username, avatar_url)"
      )
      .eq("assembled_read_id", readId)
      .order("created_at", { ascending: false });
    setComments((data as unknown as Comment[]) ?? []);
  }, [supabase, readId]);

  useEffect(() => {
    load();
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, [load, supabase]);

  async function post() {
    if (!body.trim() || !userId) return;
    setPosting(true);
    await supabase
      .from("comments")
      .insert({ assembled_read_id: readId, user_id: userId, body: body.trim() });
    setBody("");
    setPosting(false);
    load();
  }

  return (
    <div className="mt-4">
      {userId ? (
        <div className="flex gap-2">
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && post()}
            placeholder="Add a comment…"
            className="flex-1 rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
          />
          <button
            onClick={post}
            disabled={posting || !body.trim()}
            className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Post
          </button>
        </div>
      ) : (
        <p className="text-sm text-muted">
          <Link href="/sign-in" className="text-brick hover:underline">
            Sign in
          </Link>{" "}
          to comment.
        </p>
      )}

      <div className="mt-4 space-y-3">
        {comments.map((c) => (
          <div key={c.id} className="rounded-lg border border-tan bg-ivory p-3">
            <div className="flex items-center gap-2 text-sm">
              {c.user?.username ? (
                <Link href={`/u/${c.user.username}`} className="font-medium hover:text-brick">
                  {c.user.display_name}
                </Link>
              ) : (
                <span className="font-medium">{c.user?.display_name ?? "User"}</span>
              )}
              <span className="text-xs text-muted">
                {new Date(c.created_at).toLocaleDateString()}
              </span>
            </div>
            <p className="mt-1 text-sm text-taupe">{c.body}</p>
          </div>
        ))}
        {comments.length === 0 && (
          <p className="text-sm text-muted">No comments yet — be the first.</p>
        )}
      </div>
    </div>
  );
}
