// UX1 (OWNER DECISION 5): sign-up asks "Create a company" or "Join my team". Only "Create a company" lets a new person's sign-in create one; joining
// needs an invite link, and the screen says where one comes from. A pasted invite link opens on this app's own origin.
import { useState } from "react";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { TextField } from "../../design/TextField.js";
import { joinLinkPath } from "../../text/links.js";
import "./onboarding.css";
export function SignupScreen() {
 const host = useAppHost(), [joining, setJoining] = useState(false), [link, setLink] = useState(""), [error, setError] = useState<string>();
 function openInvite() { const path = joinLinkPath(link);if (path === undefined) { setError("That isn't a complete Rovara invite link. Copy the whole link from the invite you were sent.");return; }setError(undefined);host.navigate(path); }
 return <main className="rv-entry rv-onboarding-entry"><p className="rv-eyebrow">Rovara</p><PageHeader title="Start with Rovara" description="Turn a useful way of working into something your team can use together." focusOnMount />
  <div className="rv-signup-choices" role="group" aria-label="How do you want to start?">
   <Button variant="primary" onClick={() => host.signIn("/app/welcome", { createCompany: true })}>Create a company</Button>
   <Button aria-expanded={joining} onClick={() => setJoining(!joining)}>Join my team</Button>
  </div>
  <p>Creating a company starts a free trial when you connect GitHub.</p>
  <p className="rv-muted">Some Rovara installs are invitation-only. If yours is, you will be told after you sign in, and nothing is created: ask someone at your company to invite you.</p>
  {joining && <section aria-label="Join my team"><h2>Join my team</h2><p>To join your team you need an invite link. Ask an owner or admin of your company to invite you: in Rovara they open Administration, then Invites, and send you a link by email or chat.</p><p>Open the link you were sent, or paste it here.</p>
   <form onSubmit={event => { event.preventDefault();openInvite(); }}><TextField label="Invite link" value={link} autoComplete="off" onChange={event => { setLink(event.target.value);setError(undefined); }} /><Button type="submit" disabled={link.trim() === ""}>Open invite</Button></form>{error && <p role="alert">{error}</p>}</section>}
  <p className="rv-muted">Already have an account? <Button variant="quiet" onClick={() => host.signIn("/app")}>Sign in</Button></p></main>;
}
