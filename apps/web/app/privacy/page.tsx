import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "Privacy Policy - Prelogue Studio",
  description: "How Prelogue collects, uses, and protects your data.",
};

const h2 = "mt-8 font-slab text-xl text-ink";
const p = "mt-3 text-[15px] leading-relaxed text-taupe";
const li = "mt-1.5 text-[15px] leading-relaxed text-taupe";

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <SiteHeader />
      <article className="mt-10">
        <h1 className="font-slab text-3xl text-ink">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted">Last updated: June 29, 2026</p>

        <p className={p}>
          Prelogue (&ldquo;Prelogue,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) is a platform where writers
          share screenplays as table reads, AI voices and actors perform the roles, and audiences listen.
          This policy explains what we collect, how we use it, and the choices you have. By using Prelogue
          (prelogue.studio or our mobile apps) you agree to this policy.
        </p>

        <h2 className={h2}>Information we collect</h2>
        <ul>
          <li className={li}>
            <strong>Account &amp; profile.</strong> Email address, display name, username, optional bio,
            avatar photo, role (writer / actor / audience), and links you choose to add (website, social
            media, IMDb).
          </li>
          <li className={li}>
            <strong>Writer content.</strong> Screenplays you upload, their parsed text, titles, loglines,
            genres, and any supporting documents (e.g. rights/treatment files) you attach.
          </li>
          <li className={li}>
            <strong>Actor content.</strong> Video and audio you record to read a role, and the takes you
            submit.
          </li>
          <li className={li}>
            <strong>Activity.</strong> Casting choices, votes, comments, and basic usage/diagnostic data.
          </li>
          <li className={li}>
            <strong>Payments.</strong> When you unlock a script, payment is processed by Stripe. We do not
            see or store your full card details.
          </li>
        </ul>

        <h2 className={h2}>How we use your information</h2>
        <ul>
          <li className={li}>To provide the service — host scripts, generate AI voice reads, splice in actor recordings, and play table reads.</li>
          <li className={li}>To operate accounts, profiles, casting, notifications, and payments.</li>
          <li className={li}>To moderate content and keep the platform safe.</li>
          <li className={li}>To improve the product and fix problems.</li>
        </ul>

        <h2 className={h2}>Service providers we share data with</h2>
        <p className={p}>
          We use trusted third parties to run Prelogue. They process data only to provide their service to us:
        </p>
        <ul>
          <li className={li}><strong>Supabase</strong> — database, file storage, and authentication.</li>
          <li className={li}><strong>Vercel</strong> — website hosting and privacy-friendly, cookieless analytics.</li>
          <li className={li}>
            <strong>ElevenLabs</strong> — AI voice generation. Script text (and, for custom voices, your
            voice description) is sent to ElevenLabs to synthesize speech.
          </li>
          <li className={li}>
            <strong>SightEngine</strong> — automated content moderation. Uploaded videos and profile photos
            are screened before they become visible to others.
          </li>
          <li className={li}><strong>Stripe</strong> — payment processing.</li>
          <li className={li}><strong>Resend</strong> — transactional email (sign-in codes, invites, notifications).</li>
        </ul>
        <p className={p}>
          We do not sell your personal information. We may disclose information if required by law or to
          protect the rights, safety, and security of our users and the platform.
        </p>

        <h2 className={h2}>User-generated content &amp; visibility</h2>
        <p className={p}>
          Scripts, recordings, profiles, and avatars are user-generated content. What you publish is visible
          according to the settings you choose (public, unlisted, or invite-only for scripts). Recorded reads
          and avatars are screened by automated moderation before they appear to others. You are responsible
          for the content you upload and must have the rights to it.
        </p>

        <h2 className={h2}>Data retention &amp; deletion</h2>
        <p className={p}>
          We keep your information for as long as your account is active. You can delete your reads from your
          profile, and you can delete your entire account at any time (in the app, or by contacting us) —
          which removes your scripts, recordings, and personal data, subject to limited records we must keep
          for legal or accounting reasons.
        </p>

        <h2 className={h2}>Your choices &amp; rights</h2>
        <p className={p}>
          Depending on where you live, you may have rights to access, correct, export, or delete your
          personal data, and to object to certain processing. You can exercise most of these in-app, or
          contact us and we&rsquo;ll help.
        </p>

        <h2 className={h2}>Children</h2>
        <p className={p}>
          Prelogue is not directed to children under 13, and you must be at least 13 to use it. If you are
          under 18, you may use Prelogue only with the involvement and consent of a parent or guardian.
        </p>

        <h2 className={h2}>Security</h2>
        <p className={p}>
          We use industry-standard measures to protect your data, but no system is perfectly secure. Please
          use a current device and keep your account email secure.
        </p>

        <h2 className={h2}>Changes</h2>
        <p className={p}>
          We may update this policy from time to time. We&rsquo;ll change the &ldquo;last updated&rdquo; date
          above and, for material changes, give notice in the app or by email.
        </p>

        <h2 className={h2}>Contact</h2>
        <p className={p}>
          Questions? Email us at{" "}
          <a href="mailto:hello@prelogue.studio" className="text-brick underline">
            hello@prelogue.studio
          </a>
          .
        </p>
      </article>
    </main>
  );
}
