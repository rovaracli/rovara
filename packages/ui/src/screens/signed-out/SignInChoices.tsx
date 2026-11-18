import { useEffect, useState } from "react";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
/**
 * L4-SIGNIN: the sign-in buttons. "Sign in with Slack" and "Sign in with GitHub" appear side by side ONLY when Code's own sign-in configuration says both are on
 * (read through the host, never assumed); otherwise (nothing read yet, one method, an older host) there is the one plain Sign in button, which goes to Code's own
 * method page exactly as before. "Use a different workspace" appears only when this browser remembers a Slack workspace; it signs in without that hint.
 */
export function SignInChoices({ returnPath, label = "Sign in" }: { returnPath: string; label?: string }) {
 const host = useAppHost();
 const [offer, setOffer] = useState<{ slack: boolean; github: boolean } | undefined>(undefined);
 const [remembered, setRemembered] = useState(() => host.lastWorkspace?.());
 useEffect(() => {
  let live = true;
  void (async () => { try { const read = await host.signInOffer?.();if (live) setOffer(read); } catch { /* The plain button stays. */ } })();
  return () => { live = false; };
 }, [host]);
 const both = offer?.slack === true && offer.github === true;
 return <>
  {both
   ? <div className="rv-signin-choices"><Button variant="primary" data-testid="signed-out-sign-in" onClick={() => host.signIn(returnPath, { method: "slack" })}>Sign in with Slack</Button><Button data-testid="signed-out-sign-in-github" onClick={() => host.signIn(returnPath, { method: "github" })}>Sign in with GitHub</Button></div>
   : <Button variant="primary" data-testid="signed-out-sign-in" onClick={() => host.signIn(returnPath)}>{label}</Button>}
  {remembered !== undefined && <p><Button variant="quiet" data-testid="signed-out-different-workspace" onClick={() => { setRemembered(undefined);host.signIn(returnPath, { differentWorkspace: true }); }}>Use a different workspace</Button></p>}
 </>;
}
