import Link from "next/link";

/**
 * The ask, placed directly under the table read — the moment someone has just
 * heard what the product does. Ad traffic lands on the demo, plays it, and
 * previously had nothing to click afterwards.
 */
export function WriterCTA({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="mt-8 rounded-2xl border-2 border-brick bg-brick/5 p-6 text-center sm:p-8">
      <div className="font-mono text-xs uppercase tracking-widest text-brick">Your turn</div>
      <h2 className="mx-auto mt-2 max-w-lg font-slab text-2xl leading-snug sm:text-3xl">
        That&rsquo;s a table read. Now hear yours.
      </h2>
      <p className="mx-auto mt-3 max-w-md text-taupe">
        Upload your screenplay and it reads itself back the same way: every character cast, every
        line performed. It stays private, and you keep all rights.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/studio/upload"
          className="rounded-xl bg-brick px-6 py-3 font-medium text-white"
        >
          Upload your script
        </Link>
        {!signedIn && (
          <Link
            href="/sign-in?next=/studio/upload"
            className="rounded-xl border border-tan px-6 py-3 font-medium text-taupe hover:bg-ivory"
          >
            Sign in
          </Link>
        )}
      </div>
      <p className="mt-4 font-mono text-[11px] uppercase tracking-wider text-muted">
        Private by default · plans from $19/mo or $19 once
      </p>
    </section>
  );
}
