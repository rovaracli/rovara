// UX1: the one signed-out screen (the route's own copy is gone). Each fixed reason the sign-in server can give (SIGNED_OUT_REASONS) says what happened
// and the next step; nothing from a provider or an error is shown.
import { useSearchParams } from "react-router";
import { isSignedOutReason, type SignedOutReason } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
export const SIGNED_OUT_COPY: Readonly<Record<SignedOutReason, { message: string; next: string }>> = {
 ended: { message: "You've signed out.", next: "Sign in again to continue." },
 removed: { message: "Your access to this company ended.", next: "To come back, ask an owner for a new invite and open the link they send." },
 failed: { message: "We couldn't finish signing you in.", next: "Something went wrong on Rovara's side. Try again in a minute." },
 cancelled: { message: "Sign-in was cancelled.", next: "Nothing changed. Sign in when you're ready." },
 refused: { message: "That account wasn't accepted.", next: "If you used the wrong account, sign out of it at the sign-in provider (or use a private window), then sign in again." },
 no_account: { message: "There's no Rovara account for that sign-in yet, and nothing was created.", next: "Create a company to start a free trial. To join your team instead, open the invite link an owner or admin sent you." },
 unavailable: { message: "The sign-in service couldn't be reached.", next: "Try again in a minute." },
 method_unavailable: { message: "That sign-in method can't open Rovara here.", next: "Sign in with your email or GitHub instead. Slack sign-in works only once your Slack account is linked to your Rovara account (from your account menu)." },
};
export function SignedOutScreen({ reason = "failed", onSignIn, onCreateCompany }: { reason?: string; onSignIn: () => void; onCreateCompany?: () => void }) {
 const key: SignedOutReason = isSignedOutReason(reason) ? reason : "failed", copy = SIGNED_OUT_COPY[key];
 return <main className="rv-entry"><h1 tabIndex={-1}>Sign in to Rovara</h1><p>{copy.message}</p><p>{copy.next}</p>
  {key === "no_account" && onCreateCompany !== undefined ? <><Button variant="primary" onClick={onCreateCompany}>Create a company</Button><Button onClick={onSignIn}>Sign in with another account</Button></> : <Button variant="primary" onClick={onSignIn}>Sign in</Button>}</main>;
}
/** `/app/signed-out?reason=`: no reason means the person signed out. */
export function SignedOutRoute() {
 const host = useAppHost(), [params] = useSearchParams(), reason = params.get("reason") ?? "ended";
 return <SignedOutScreen reason={reason} onSignIn={() => host.signIn("/app")} onCreateCompany={() => host.signIn("/app/welcome", { createCompany: true })} />;
}
