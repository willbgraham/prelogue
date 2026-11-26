"use client";

import { useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import { trackOnceOnNextPage } from "@/lib/analytics";
import { canReceiveMail, suggestEmail } from "@/lib/emailTypo";
import { safeNext, sendCodeMessage, verifyMessage, type AuthFailure } from "@/lib/signIn";

const INCOMPLETE_ADDRESS =
  "That email address looks incomplete: the part after the @ needs an ending, such as .com. Check it and try again.";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-3 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

export default function SignInPage() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [next, setNext] = useState("/");
  // Signed in, and the next page is on its way. From here nothing on this page
  // can be pressed a second time.
  const [leaving, setLeaving] = useState(false);
  const [slow, setSlow] = useState(false);
  // The account this browser is already signed in to, if it is.
  const [already, setAlready] = useState<string | null>(null);
  // One request at a time: a second Enter can arrive before the first press
  // has disabled the button.
  const busy = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(safeNext(params.get("next"), window.location.origin));
    // The auth callback bounces here with ?error=auth when a link is invalid
    // or expired — say so instead of showing a pristine form.
    if (params.get("error") === "auth") {
      setError("That sign-in link didn't work — it may have expired. Enter your email for a fresh code.");
    }

    // Someone already signed in can still be shown this page (another tab
    // that hasn't caught up, an old link). Offer the way on instead of
    // making them wait for a code they don't need.
    let alive = true;
    getBrowserClient()
      .auth.getUser()
      .then(({ data }) => {
        if (alive && data?.user?.email) setAlready(data.user.email);
      })
      .catch(() => {});

    // A page the browser brings back whole (Back, after leaving it) comes
    // back exactly as it was left: held, mid-sign-in. Let it be used again.
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      busy.current = false;
      setLeaving(false);
      setSlow(false);
      setLoading(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => {
      alive = false;
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  // The next page normally opens within a second. If it hasn't after a few,
  // give the visitor something to press.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setSlow(true), 6000);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  /**
   * Go on to the page the visitor was heading for, with a full page load.
   *
   * Not the router. A visitor who presses "Upload a script" while signed out
   * is sent here, and the router remembers, for five minutes, that the upload
   * page's address leads to this page. Asked to go there after the code is
   * accepted, it answers from that memory: this page again. The visitor,
   * signed in, was left looking at the code form with a live button, and a
   * second press sent a code that had already been used. A full page load
   * starts from nothing remembered, so the server decides, and it knows the
   * visitor is signed in. `replace`, so that Back from the next page doesn't
   * return to this form.
   */
  function leave() {
    setLeaving(true);
    setError(null);
    setNotice(null);
    window.location.replace(next);
  }

  async function requestCode(address: string, resend = false) {
    if (busy.current || leaving) return;
    // Whatever led here, never ask for a code that has nowhere to go.
    if (!canReceiveMail(address)) {
      setError(INCOMPLETE_ADDRESS);
      return;
    }
    busy.current = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    let failure: AuthFailure | null = null;
    try {
      const { error } = await getBrowserClient().auth.signInWithOtp({
        email: address,
        options: { shouldCreateUser: true },
      });
      failure = error;
    } catch {
      failure = { status: 0 };
    }
    busy.current = false;
    setLoading(false);
    if (failure) {
      setError(sendCodeMessage(failure));
      return;
    }
    setSuggestion(null);
    setEmail(address);
    setStep("code");
    if (resend) {
      // The code typed so far belongs to the email this one replaces.
      setCode("");
      setNotice("A new code is on its way. Only the newest code works.");
    }
  }

  function sendCode(e: React.FormEvent) {
    e.preventDefault();
    const typed = email.trim();
    const meant = suggestEmail(typed);
    // "name@gmail", "name@gmail.c": no mail server delivers there, so this is
    // not the visitor's to overrule. Offer the address they most likely meant
    // when the provider is recognisable; otherwise say what is missing.
    if (!canReceiveMail(typed)) {
      setSuggestion(meant);
      setError(meant ? null : INCOMPLETE_ADDRESS);
      return;
    }
    // A mistyped domain sends the code nowhere, and the visitor waits for an
    // email that can't arrive. Ask first — the choice stays theirs, because
    // real domains do sit one letter away from famous ones.
    if (meant) {
      setError(null);
      setSuggestion(meant);
      return;
    }
    void requestCode(typed);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (busy.current || leaving) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    const client = getBrowserClient();
    const address = email.trim();
    let user: { id: string } | null = null;
    let failure: AuthFailure | null = null;
    try {
      const { data, error } = await client.auth.verifyOtp({
        email: address,
        token: code.trim(),
        type: "email",
      });
      user = data?.user ?? null;
      failure = error;
    } catch {
      failure = { status: 0 };
    }
    if (failure) {
      // A code works once. If this browser is nonetheless signed in to this
      // address, an earlier check of the code went through (another tab, a
      // doubled press): that is signed in, not an error.
      user = await signedInAs(address);
      if (!user) {
        busy.current = false;
        setLoading(false);
        setError(verifyMessage(failure));
        return;
      }
    }
    // Ad attribution: count a signup once per account, not on every sign-in.
    // Fired by the next page — this one is about to be left.
    if (user?.id) trackOnceOnNextPage(`reg:${user.id}`, "CompleteRegistration");
    // `loading` and `busy` stay set: the button is held until the next page.
    leave();
  }

  async function signedInAs(address: string): Promise<{ id: string } | null> {
    try {
      const { data } = await getBrowserClient().auth.getUser();
      const u = data?.user;
      return u?.email && u.email.toLowerCase() === address.toLowerCase() ? u : null;
    } catch {
      return null;
    }
  }

  return (
    <>
      <h1 className="font-slab text-2xl">
        {step === "email" ? "Sign in or sign up" : "Enter your code"}
      </h1>
      {next.startsWith("/record") && step === "email" && (
        <p className="mt-2 text-sm text-taupe">Sign in to record your read.</p>
      )}

      {already && step === "email" && (
        <div role="status" className="mt-6 rounded-lg border border-tan bg-elevated px-4 py-3">
          <p className="text-sm text-taupe">
            You&rsquo;re already signed in as{" "}
            <strong className="break-words text-ink">{already}</strong>.
          </p>
          <button
            type="button"
            disabled={leaving}
            onClick={leave}
            className="mt-3 w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
          >
            {leaving ? "One moment…" : "Continue"}
          </button>
          {leaving && slow && <StillHere next={next} />}
          <p className="mt-3 text-center text-xs text-muted">
            Or sign in to a different account below.
          </p>
        </div>
      )}

      {step === "email" ? (
        <form onSubmit={sendCode} className="mt-6 flex flex-col gap-4">
          {error && <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}
          <label className="flex flex-col gap-1">
            <span className={label}>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setSuggestion(null);
              }}
              className={input}
            />
          </label>
          {suggestion ? (
            <div role="status" className="rounded-lg border border-tan bg-elevated px-4 py-3">
              <p className="text-sm text-taupe">
                Did you mean <strong className="break-words text-ink">{suggestion}</strong>?
              </p>
              <button
                type="button"
                disabled={loading}
                onClick={() => requestCode(suggestion)}
                className="mt-3 w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
              >
                {loading ? "Sending…" : "Yes, send my code there"}
              </button>
              {/* An address that can't receive mail can't be "right". */}
              {canReceiveMail(email) && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => requestCode(email.trim())}
                  className="mt-1 w-full break-words px-4 py-2 text-sm text-taupe underline hover:text-ink disabled:opacity-60"
                >
                  No, {email.trim()} is right
                </button>
              )}
            </div>
          ) : (
            <button
              disabled={loading || leaving}
              className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
            >
              {loading ? "Sending…" : "Email me a code"}
            </button>
          )}
          <p className="text-center text-xs text-muted">
            We&rsquo;ll email you a 6-digit code — no password needed.
          </p>
          <p className="text-center text-xs text-muted">
            By continuing you agree to our{" "}
            <a href="/terms" className="underline hover:text-brick">
              Terms
            </a>{" "}
            and{" "}
            <a href="/privacy" className="underline hover:text-brick">
              Privacy Policy
            </a>
            .
          </p>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-6 flex flex-col gap-4">
          {error && (
            <p role="alert" className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">
              {error}
            </p>
          )}
          {notice && !error && (
            <p role="status" className="rounded-lg border border-tan bg-elevated px-3 py-2 text-sm text-taupe">
              {notice}
            </p>
          )}
          <p className="text-sm text-taupe">
            We sent a 6-digit code to <strong className="break-words text-ink">{email}</strong>.
          </p>
          <label className="flex flex-col gap-1">
            <span className={label}>6-digit code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
              readOnly={leaving}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
              className={`${input} text-center text-2xl tracking-[0.5em]`}
            />
          </label>
          <button
            disabled={loading || leaving || code.length < 6}
            className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
          >
            {leaving ? "Signing you in…" : loading ? "Verifying…" : "Verify & continue"}
          </button>
          {leaving ? (
            slow && <StillHere next={next} />
          ) : (
            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                  setNotice(null);
                }}
                className="text-taupe hover:text-ink disabled:opacity-60"
              >
                ← Use a different email
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => requestCode(email.trim(), true)}
                className="text-taupe hover:text-ink disabled:opacity-60"
              >
                Resend code
              </button>
            </div>
          )}
        </form>
      )}
    </>
  );
}

/** Signed in, but the next page hasn't opened after several seconds (a slow
 *  connection, usually). A plain link is a full page load too. */
function StillHere({ next }: { next: string }) {
  return (
    <p role="status" className="mt-3 text-center text-sm text-taupe">
      You&rsquo;re signed in. If the page hasn&rsquo;t opened,{" "}
      <a href={next} className="underline hover:text-brick">
        continue here
      </a>
      .
    </p>
  );
}
