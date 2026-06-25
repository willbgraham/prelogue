import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-8 flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brick font-slab text-lg text-white">
          P
        </div>
        <span className="font-slab text-lg">Prelogue</span>
      </Link>
      {children}
    </main>
  );
}
