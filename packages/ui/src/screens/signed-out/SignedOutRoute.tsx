import { useSearchParams } from "react-router";
import { AuthStage } from "./AuthStage.js";
import { SignInChoices } from "./SignInChoices.js";

function reasonDetails(reason: string | null): { message: string; tone: "info" | "warn" | "danger" } {
  if (reason === "removed") return { message: "Your access to this organization ended.", tone: "danger" };
  if (reason === "failed") return { message: "We couldn't finish signing you in. Try again.", tone: "danger" };
  if (reason === "cancelled") return { message: "Sign-in was cancelled.", tone: "warn" };
  return { message: "You've signed out.", tone: "info" };
}

export function SignedOutRoute() {
  const [params] = useSearchParams();
  const { message, tone } = reasonDetails(params.get("reason"));
  return (
    <AuthStage
      testId="signed-out"
      footer={<p>Protected by single sign-on through your team workspace.</p>}
    >
      <div className="rv-auth-card-head">
        <h1 tabIndex={-1}>Sign in to Rovara</h1>
        <p className="rv-auth-notice" data-tone={tone} data-testid="signed-out-message">{message}</p>
      </div>
      <SignInChoices returnPath="/app" />
    </AuthStage>
  );
}
