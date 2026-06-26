import Link from "next/link";
import Image from "next/image";
import { AuthNav } from "@/components/AuthNav";

/**
 * Shared site header — wordmark (home) + primary nav + auth controls.
 * Used on the landing, How it works, and Pricing pages.
 */
export function SiteHeader() {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Link href="/" className="flex items-center gap-3">
        <Image
          src="/app-icon.png"
          alt="Prelogue"
          width={40}
          height={40}
          priority
          className="h-10 w-10 rounded-[10px] border border-tan"
        />
        <span className="font-slab text-xl">Prelogue</span>
      </Link>
      <nav className="ml-auto flex items-center gap-4 sm:gap-5">
        <Link
          href="/how-it-works"
          className="text-sm font-medium text-taupe hover:text-brick"
        >
          How it works
        </Link>
        <Link
          href="/pricing"
          className="text-sm font-medium text-taupe hover:text-brick"
        >
          Pricing
        </Link>
        <AuthNav />
      </nav>
    </header>
  );
}
