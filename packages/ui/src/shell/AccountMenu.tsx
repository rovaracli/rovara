import { useState } from "react";
import { Link } from "react-router";
import { LeaveOrganizationResponseReaderSchema, isPlaceholderDisplayName, type ReadAppNav } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { useTheme, type ThemePreference } from "../theme.js";
import { Button } from "../design/Button.js";
import { Dialog } from "../design/Dialog.js";
import { VisibleText } from "../design/VisibleText.js";
import { ApiError } from "../api/errors.js";
import { createApiClient } from "../api/client.js";
import { ConfirmInBrowser } from "../confirm/ConfirmInBrowser.js";
import type { SendResult } from "../api/client.js";
import { NameForm } from "./NameForm.js";
import { SlackLink, slackLinkOutcome } from "./SlackLink.js";
import { GithubLink, githubLinkOutcome } from "./GithubLink.js";
export function AccountMenu({ nav }: { nav: ReadAppNav }) {
 const host = useAppHost(), theme = useTheme();
 const outcome = slackLinkOutcome(host.currentPath()), githubOutcome = (host.currentPath().startsWith("/app/onboard") || host.currentPath().startsWith("/app/admin/connections")) ? undefined : githubLinkOutcome(host.currentPath());
 // UX1: `?account=leave` (from an invite to another company) opens the account menu on its Leave step.
 const leaveAsked = new URLSearchParams(host.currentPath().split("?", 2)[1] ?? "").get("account") === "leave";
 const [open, setOpen] = useState(outcome !== undefined || githubOutcome !== undefined), [leaving, setLeaving] = useState(leaveAsked), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
 async function signOut() { setBusy(true);setError(undefined);try { await host.signOut();host.signIn("/app"); } catch (error) { setError(error instanceof ApiError ? error.message : "Couldn't sign out. Try again."); } finally { setBusy(false); } }
 async function leave() {
 setBusy(true);setError(undefined);
 try {
 const result = await createApiClient(host).send("POST", "/v1/app/org/leave", { requestId: crypto.randomUUID() }, LeaveOrganizationResponseReaderSchema);
 if (result.kind !== "done") { setPending(result);return; }
 await host.signOut();host.signIn("/app");
 } catch (error) { setError(error instanceof ApiError ? error.message : "Couldn't leave the organization. Try again."); } finally { setBusy(false); }
 }
 return <><Dialog title="Your account" open={open} onOpenChange={setOpen} trigger={<Button aria-label="Open account menu" variant="quiet"><VisibleText text={nav.me.name} /></Button>}><p><VisibleText text={nav.org.name} /></p><NameForm key={nav.me.name} label="Your name" initial={isPlaceholderDisplayName(nav.me.name) ? "" : nav.me.name} submit="Save name" /><fieldset className="rv-theme-options"><legend>Appearance</legend>{(["system", "light", "dark"] as const).map((value: ThemePreference) => <label key={value}><input type="radio" name="appearance" value={value} checked={theme.preference === value} onChange={() => theme.setPreference(value)} />{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</label>)}</fieldset><SlackLink outcome={outcome} /><p><Link to="/app/account#notifications" onClick={() => setOpen(false)}>How you're notified</Link></p><GithubLink outcome={githubOutcome} /><div className="rv-account-actions"><Button onClick={() => setLeaving(true)}>Leave organization</Button><Button onClick={() => { void signOut(); }} busy={busy}>Sign out</Button></div>{nav.release !== undefined && <p className="rv-muted">Rovara {nav.release}</p>}{error && <p role="alert"><VisibleText text={error} /></p>}</Dialog>
 <Dialog title="Leave organization?" description={`You will lose access to ${nav.org.name}'s work. If you are its last owner, the organization will close.${leaveAsked ? " Then open your invite link again to join the other company." : ""}`} open={leaving} onOpenChange={setLeaving}><Button variant="danger" busy={busy} onClick={() => { void leave(); }}>Leave organization</Button>{pending && <ConfirmInBrowser result={pending} subjectKey={["me"]} isApplied={() => false} />}{error && <p role="alert"><VisibleText text={error} /></p>}</Dialog></>;
}
