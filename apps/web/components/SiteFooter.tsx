import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-tan/60 px-6 py-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 text-sm text-taupe sm:flex-row sm:justify-between">
        <span className="text-muted">© 2026 Prelogue</span>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <Link href="/discover" className="hover:text-brick">
            Discover
          </Link>
          <Link href="/how-it-works" className="hover:text-brick">
            How it works
          </Link>
          <Link href="/pricing" className="hover:text-brick">
            Pricing
          </Link>
          <Link href="/privacy" className="hover:text-brick">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-brick">
            Terms
          </Link>
        </nav>
      </div>
    </footer>
  );
}
