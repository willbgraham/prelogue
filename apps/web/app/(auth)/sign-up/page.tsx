import { redirect } from "next/navigation";

// Passwordless now — one email-code flow handles both sign-in and sign-up.
export default function SignUpPage() {
  redirect("/sign-in");
}
