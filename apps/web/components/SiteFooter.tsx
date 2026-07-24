import Link from "next/link";
import { NewsletterSignup } from "@/components/NewsletterSignup";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-tan/60 px-6 py-8">
      <div className="mx-auto w-full max-w-5xl">
        {/* Newsletter */}
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-slab text-lg leading-tight">Get new script releases &amp; news</h3>
            <p className="mt-0.5 text-sm text-taupe">
              Fresh table reads and Prelogue updates - no spam, unsubscribe anytime.
            </p>
          </div>
          <NewsletterSignup />
        </div>

        {/* Links */}
        <div className="mt-8 flex flex-col items-center gap-3 border-t border-tan/60 pt-6 text-sm text-taupe sm:flex-row sm:justify-between">
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
      </div>
    </footer>
  );
}
