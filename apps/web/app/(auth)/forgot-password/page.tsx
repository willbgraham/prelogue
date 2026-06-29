import { redirect } from "next/navigation";

// Passwordless now — no password to reset; sign in with an email code.
export default function ForgotPasswordPage() {
  redirect("/sign-in");
}
