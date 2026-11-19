import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** A connect step offers an explicit sign-in action only for Cloud's authenticated-session expiry response. */
export function ConnectStepError({ error, fallback, testId, onSignIn }: { error: unknown; fallback: string; testId: string; onSignIn: () => void }) {
 const message = error instanceof Error ? error.message : fallback;
 const signInExpired = error instanceof ApiError && error.status === 401 && error.code === "AUTH_REQUIRED";
 return <><p role="alert" data-testid={testId}><VisibleText text={message} /></p>{signInExpired && <Button onClick={onSignIn}>Sign in again</Button>}</>;
}
