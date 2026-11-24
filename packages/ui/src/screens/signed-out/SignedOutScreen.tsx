import { Button } from "../../design/Button.js";
import { AuthStage } from "./AuthStage.js";

const REASONS: Record<string, { text: string; tone: "info" | "warn" | "danger" }> = {
  removed: { text: "You're no longer a member of this organization. Ask an owner to invite you again.", tone: "danger" },
  ended: { text: "Your sign-in was ended. Sign in again to continue.", tone: "info" },
  cancelled: { text: "Sign-in was cancelled.", tone: "warn" },
  failed: { text: "Sign-in didn't work. Try again in a minute.", tone: "danger" },
};

export function SignedOutScreen({ reason = "failed", onSignIn }: { reason?: string; onSignIn: () => void }) {
  const details = Object.hasOwn(REASONS, reason) ? REASONS[reason]! : REASONS.failed!;
  return (
    <AuthStage footer={<p>Use your workspace identity to pick up right where you left off.</p>}>
      <div className="rv-auth-card-head">
        <h1 tabIndex={-1}>Sign in to Rovara</h1>
        <p className="rv-auth-notice" data-tone={details.tone}>{details.text}</p>
      </div>
      <div className="rv-auth-actions">
        <Button variant="primary" onClick={onSignIn}>Sign in</Button>
      </div>
    </AuthStage>
  );
}
