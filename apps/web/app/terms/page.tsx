import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "Terms of Service — Prelogue",
  description: "The terms that govern your use of Prelogue.",
};

const h2 = "mt-8 font-slab text-xl text-ink";
const p = "mt-3 text-[15px] leading-relaxed text-taupe";
const li = "mt-1.5 text-[15px] leading-relaxed text-taupe";

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <SiteHeader />
      <article className="mt-10">
        <h1 className="font-slab text-3xl text-ink">Terms of Service</h1>
        <p className="mt-2 text-sm text-muted">Last updated: June 29, 2026</p>

        <p className={p}>
          These Terms govern your use of Prelogue (prelogue.studio and our mobile apps). By creating an
          account or using Prelogue, you agree to these Terms. If you don&rsquo;t agree, please don&rsquo;t
          use the service.
        </p>

        <h2 className={h2}>Eligibility</h2>
        <p className={p}>
          You must be at least 13 years old to use Prelogue. If you are under 18, you may use it only with
          the consent and involvement of a parent or guardian. You are responsible for keeping your account
          secure.
        </p>

        <h2 className={h2}>Your content &amp; rights</h2>
        <ul>
          <li className={li}>
            <strong>Writers.</strong> You must own or have the rights to any screenplay you upload. You
            confirm this when you upload. You keep ownership of your scripts.
          </li>
          <li className={li}>
            <strong>Actors.</strong> You keep ownership of the reads you record. By submitting a read, you
            grant Prelogue and the relevant writer a non-exclusive, worldwide license to host, display, and
            play your recording as part of that script&rsquo;s table reads on the platform.
          </li>
          <li className={li}>
            <strong>Everyone.</strong> You&rsquo;re responsible for the content you upload and must have the
            rights to it. You grant us the limited license needed to operate the service (store, process,
            moderate, and display your content as you&rsquo;ve configured it).
          </li>
        </ul>

        <h2 className={h2}>AI voices</h2>
        <p className={p}>
          Prelogue generates synthetic voices to read script roles using third-party AI (ElevenLabs).
          AI-generated audio is provided for performing table reads on the platform. You agree not to use
          designed or generated voices to impersonate real people or for unlawful or deceptive purposes.
        </p>

        <h2 className={h2}>Acceptable use</h2>
        <p className={p}>You agree not to:</p>
        <ul>
          <li className={li}>Upload content you don&rsquo;t have the rights to, or that infringes others&rsquo; rights.</li>
          <li className={li}>Upload unlawful, hateful, harassing, sexually explicit, or otherwise objectionable content.</li>
          <li className={li}>Impersonate others, or misuse voices or recordings.</li>
          <li className={li}>Attempt to disrupt, scrape, or abuse the service or its APIs.</li>
        </ul>
        <p className={p}>
          We use automated moderation and may remove content or suspend accounts that violate these Terms.
          We have no tolerance for objectionable content or abusive users.
        </p>

        <h2 className={h2}>Payments</h2>
        <p className={p}>
          Some features (such as unlocking a script&rsquo;s full AI table read) are paid. Prices are shown
          before purchase. A script unlock is a <strong>one-time purchase</strong> for that script — not a
          subscription. Payments are processed by Stripe. Except where required by law, purchases are
          non-refundable; if something goes wrong, contact us and we&rsquo;ll make it right.
        </p>

        <h2 className={h2}>Termination</h2>
        <p className={p}>
          You can stop using Prelogue and delete your account at any time. We may suspend or terminate
          accounts that violate these Terms or the law.
        </p>

        <h2 className={h2}>Disclaimers &amp; limitation of liability</h2>
        <p className={p}>
          Prelogue is provided &ldquo;as is,&rdquo; without warranties of any kind. To the maximum extent
          permitted by law, Prelogue and its operators are not liable for indirect, incidental, or
          consequential damages, and our total liability is limited to the amount you paid us in the 12
          months before the claim.
        </p>

        <h2 className={h2}>Changes</h2>
        <p className={p}>
          We may update these Terms. We&rsquo;ll update the date above and give notice of material changes.
          Continued use after changes means you accept them.
        </p>

        <h2 className={h2}>Contact</h2>
        <p className={p}>
          Questions about these Terms? Email{" "}
          <a href="mailto:hello@prelogue.studio" className="text-brick underline">
            hello@prelogue.studio
          </a>
          .
        </p>
      </article>
    </main>
  );
}
