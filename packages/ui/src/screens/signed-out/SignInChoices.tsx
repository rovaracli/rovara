import { useEffect, useState } from "react";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";

function SlackIcon() {
  return (
    <svg className="rv-signin-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52Zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313ZM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834Zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312Zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834Zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312Zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52Zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="rv-signin-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1.27a11 11 0 0 0-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.65-1.28-1.65-.92-.65.1-.65.1-.65 1.1 0 1.73 1.1 1.73 1.1.92 1.65 2.57 1.2 3.21.92a2.16 2.16 0 0 1 .64-1.47c-2.47-.27-5.04-1.19-5.04-5.5 0-1.1.46-2.1 1.2-2.84a3.76 3.76 0 0 1 0-2.93s.91-.28 3.11 1.1c1.8-.49 3.7-.49 5.5 0 2.1-1.38 3.02-1.1 3.02-1.1a3.76 3.76 0 0 1 0 2.93c.83.74 1.2 1.74 1.2 2.94 0 4.21-2.57 5.13-5.04 5.4.45.37.82.92.82 2.02v3.03c0 .27.1.64.73.55A11 11 0 0 0 12 1.27Z" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg className="rv-signin-icon" aria-hidden="true" focusable="false" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 10h11m-4.5-4.5L15.5 10 11 14.5" />
    </svg>
  );
}

/**
 * L4-SIGNIN: the sign-in buttons. "Sign in with Slack" and "Sign in with GitHub" appear together ONLY when Code's own sign-in configuration says both are on
 * (read through the host, never assumed); otherwise (nothing read yet, one method, an older host) there is the one plain Sign in button, which goes to Code's own
 * method page exactly as before. "Use a different workspace" appears only when this browser remembers a Slack workspace; it signs in without that hint.
 */
export function SignInChoices({ returnPath, label = "Sign in" }: { returnPath: string; label?: string }) {
  const host = useAppHost();
  const [offer, setOffer] = useState<{ slack: boolean; github: boolean } | undefined>(undefined);
  const [remembered, setRemembered] = useState(() => host.lastWorkspace?.());
  useEffect(() => {
    let live = true;
    void (async () => { try { const read = await host.signInOffer?.(); if (live) setOffer(read); } catch { /* The plain button stays. */ } })();
    return () => { live = false; };
  }, [host]);
  const both = offer?.slack === true && offer.github === true;
  return (
    <div className="rv-auth-actions">
      {both ? (
        <div className="rv-signin-choices">
          <Button variant="primary" data-testid="signed-out-sign-in" onClick={() => host.signIn(returnPath, { method: "slack" })}>
            <SlackIcon />Sign in with Slack
          </Button>
          <Button data-testid="signed-out-sign-in-github" onClick={() => host.signIn(returnPath, { method: "github" })}>
            <GitHubIcon />Sign in with GitHub
          </Button>
        </div>
      ) : (
        <Button variant="primary" data-testid="signed-out-sign-in" onClick={() => host.signIn(returnPath)}>
          {label}<ArrowRightIcon />
        </Button>
      )}
      {remembered !== undefined && (
        <p className="rv-signin-alt">
          <Button variant="quiet" data-testid="signed-out-different-workspace" onClick={() => { setRemembered(undefined); host.signIn(returnPath, { differentWorkspace: true }); }}>
            Use a different workspace
          </Button>
        </p>
      )}
    </div>
  );
}
