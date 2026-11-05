import { useState } from "react";
import { LeaveOrganizationResponseReaderSchema, isPlaceholderDisplayName, type ReadAppNav } from "@agentx/contracts/web";
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
export function AccountMenu({ nav }: { nav: ReadAppNav }) {
 const host = useAppHost(), theme = useTheme();
 const [open, setOpen] = useState(false), [leaving, setLeaving] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
 async function signOut() { setBusy(true);setError(undefined);try { await host.signOut();host.signIn("/app"); } catch (error) { setError(error instanceof ApiError ? error.message : "Couldn't sign out. Try again."); } finally { setBusy(false); } }
 async function leave() {
 setBusy(true);setError(undefined);
 try {
 const result = await createApiClient(host).send("POST", "/v1/app/org/leave", { requestId: crypto.randomUUID() }, LeaveOrganizationResponseReaderSchema);
 if (result.kind !== "done") { setPending(result);return; }
 await host.signOut();host.signIn("/app");
 } catch (error) { setError(error instanceof ApiError ? error.message : "Couldn't leave the organization. Try again."); } finally { setBusy(false); }
 }
 return <><Dialog title="Your account" open={open} onOpenChange={setOpen} trigger={<Button aria-label="Open account menu" variant="quiet"><VisibleText text={nav.me.name} /></Button>}><p><VisibleText text={nav.org.name} /></p><NameForm key={nav.me.name} label="Your name" initial={isPlaceholderDisplayName(nav.me.name) ? "" : nav.me.name} submit="Save name" /><fieldset className="rv-theme-options"><legend>Appearance</legend>{(["system", "light", "dark"] as const).map((value: ThemePreference) => <label key={value}><input type="radio" name="appearance" value={value} checked={theme.preference === value} onChange={() => theme.setPreference(value)} />{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</label>)}</fieldset><div className="rv-account-actions"><Button onClick={() => setLeaving(true)}>Leave organization</Button><Button onClick={() => { void signOut(); }} busy={busy}>Sign out</Button></div>{nav.release !== undefined && <p className="rv-muted">Rovara {nav.release}</p>}{error && <p role="alert"><VisibleText text={error} /></p>}</Dialog>
 <Dialog title="Leave organization?" description="You will lose access to this organization's work. If you are its last owner, the organization will close." open={leaving} onOpenChange={setLeaving}><Button variant="danger" busy={busy} onClick={() => { void leave(); }}>Leave organization</Button>{pending && <ConfirmInBrowser result={pending} subjectKey={["me"]} isApplied={() => false} />}{error && <p role="alert"><VisibleText text={error} /></p>}</Dialog></>;
}
