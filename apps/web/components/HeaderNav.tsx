"use client";

import Link from "next/link";
import { useState } from "react";
import { signOut } from "@/app/auth/actions";
import { BellIcon, MenuIcon } from "@/components/icons";

const LINKS = [
  { href: "/discover", label: "Discover" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
];

type NavUser = { name: string; username: string | null } | null;

/**
 * Responsive site nav. On wider screens everything sits inline (notifications
 * bell tucked just left of Sign out); below `sm` the links collapse into a
 * hamburger menu, with the bell kept visible for quick access.
 */
export function HeaderNav({ user }: { user: NavUser }) {
  const [open, setOpen] = useState(false);

  const bell = (
    <Link href="/notifications" aria-label="Notifications" className="text-taupe hover:text-brick">
      <BellIcon className="h-5 w-5" />
    </Link>
  );

  return (
    <div className="relative ml-auto flex items-center gap-4 sm:gap-5">
      {/* Desktop / tablet */}
      <nav className="hidden items-center gap-5 sm:flex">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="text-sm font-medium text-taupe hover:text-brick"
          >
            {l.label}
          </Link>
        ))}
        {user ? (
          <>
            <Link href="/studio" className="text-sm font-medium hover:text-brick">
              Studio
            </Link>
            {user.username ? (
              <Link href={`/u/${user.username}`} className="text-sm text-taupe hover:text-brick">
                {user.name}
              </Link>
            ) : (
              <span className="text-sm text-taupe">{user.name}</span>
            )}
            {bell}
            <form action={signOut}>
              <button className="rounded-lg border border-tan px-3 py-2 text-sm hover:bg-ivory">
                Sign out
              </button>
            </form>
          </>
        ) : (
          <Link
            href="/sign-in"
            className="rounded-lg border border-tan px-4 py-2 text-sm font-medium hover:bg-ivory"
          >
            Sign in
          </Link>
        )}
      </nav>

      {/* Mobile */}
      <div className="flex items-center gap-3 sm:hidden">
        {user && bell}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label="Menu"
          aria-expanded={open}
          className="text-ink hover:text-brick"
        >
          <MenuIcon className="h-6 w-6" />
        </button>
      </div>

      {open && (
        <>
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default sm:hidden"
          />
          <div className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-xl border border-tan bg-ivory py-1 shadow-lg sm:hidden">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="block px-4 py-2.5 text-sm font-medium text-taupe hover:bg-elevated hover:text-brick"
              >
                {l.label}
              </Link>
            ))}
            {user ? (
              <>
                <Link
                  href="/studio"
                  onClick={() => setOpen(false)}
                  className="block px-4 py-2.5 text-sm font-medium hover:bg-elevated"
                >
                  Studio
                </Link>
                {user.username && (
                  <Link
                    href={`/u/${user.username}`}
                    onClick={() => setOpen(false)}
                    className="block px-4 py-2.5 text-sm text-taupe hover:bg-elevated"
                  >
                    {user.name}
                  </Link>
                )}
                <div className="border-t border-tan">
                  <form action={signOut}>
                    <button className="block w-full px-4 py-2.5 text-left text-sm text-taupe hover:bg-elevated">
                      Sign out
                    </button>
                  </form>
                </div>
              </>
            ) : (
              <Link
                href="/sign-in"
                onClick={() => setOpen(false)}
                className="block px-4 py-2.5 text-sm font-medium hover:bg-elevated"
              >
                Sign in
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
