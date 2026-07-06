"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

type Comment = {
  id: string;
  body: string;
  created_at: string;
  approved: boolean;
  user_id: string;
  user: { display_name: string; username: string | null; avatar_url: string | null } | null;
};

export function ReadComments({ readId, writerId }: { readId: string; writerId?: string | null }) {
  const supabase = getBrowserClient();
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [justPosted, setJustPosted] = useState(false);

  const load = useCallback(async () => {
    // RLS returns: approved comments + your own + (for the writer) all pending too.
    const { data } = await supabase
      .from("comments")
      .select(
        "id, body, created_at, approved, user_id, user:users!comments_user_id_fkey(display_name, username, avatar_url)"
      )
      .eq("assembled_read_id", readId)
      .order("created_at", { ascending: false });
    setComments((data as unknown as Comment[]) ?? []);
  }, [supabase, readId]);

  useEffect(() => {
    load();
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, [load, supabase]);

  const isWriter = !!userId && !!writerId && userId === writerId;

  async function post() {
    if (!body.trim() || !userId) return;
    setPosting(true);
    await supabase
      .from("comments")
      .insert({ assembled_read_id: readId, user_id: userId, body: body.trim() });
    setBody("");
    setPosting(false);
    setJustPosted(true);
    load();
  }

  async function approve(id: string) {
    await supabase.from("comments").update({ approved: true }).eq("id", id);
    load();
  }
  async function remove(id: string) {
    await supabase.from("comments").delete().eq("id", id);
    load();
  }

  const pending = comments.filter((c) => !c.approved);
  const approved = comments.filter((c) => c.approved);

  function Row({ c, moderate }: { c: Comment; moderate: boolean }) {
    return (
      <div className="rounded-lg border border-tan bg-ivory p-3">
        <div className="flex items-center gap-2 text-sm">
          {c.user?.username ? (
            <Link href={`/u/${c.user.username}`} className="font-medium hover:text-brick">
              {c.user.display_name}
            </Link>
          ) : (
            <span className="font-medium">{c.user?.display_name ?? "User"}</span>
          )}
          <span className="text-xs text-muted">{new Date(c.created_at).toLocaleDateString()}</span>
          {!c.approved && (
            <span className="rounded-full bg-tan/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-taupe">
              Pending
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-taupe">{c.body}</p>
        {moderate && (
          <div className="mt-2 flex gap-2">
            {!c.approved && (
              <button
                onClick={() => approve(c.id)}
                className="rounded-lg bg-brick px-3 py-1 text-xs font-medium text-white"
              >
                Approve
              </button>
            )}
            <button
              onClick={() => remove(c.id)}
              className="rounded-lg border border-tan px-3 py-1 text-xs font-medium text-muted hover:border-brick/40 hover:text-brick"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4">
      {userId ? (
        <>
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
          {justPosted && !isWriter && (
            <p className="mt-2 text-xs text-muted">
              Thanks — your comment will appear once the writer approves it.
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">
          <Link href="/sign-in" className="text-brick hover:underline">
            Sign in
          </Link>{" "}
          to comment.
        </p>
      )}

      {/* Writer moderation queue */}
      {isWriter && pending.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Pending approval ({pending.length})
          </div>
          <div className="mt-2 space-y-3">
            {pending.map((c) => (
              <Row key={c.id} c={c} moderate />
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {approved.map((c) => (
          <Row key={c.id} c={c} moderate={isWriter} />
        ))}
        {/* A non-writer's own still-pending comments */}
        {!isWriter &&
          pending
            .filter((c) => c.user_id === userId)
            .map((c) => <Row key={c.id} c={c} moderate={false} />)}
        {approved.length === 0 && (!isWriter || pending.length === 0) && (
          <p className="text-sm text-muted">No comments yet — be the first.</p>
        )}
      </div>
    </div>
  );
}
