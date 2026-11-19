import { useState } from "react";
import { Link } from "react-router";
import { isPlaceholderDisplayName, type ReadAppNav } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { useTheme, type ThemePreference } from "../theme.js";
import { Button } from "../design/Button.js";
import { Dialog } from "../design/Dialog.js";
import { VisibleText } from "../design/VisibleText.js";
import { ApiError } from "../api/errors.js";
import { NameForm } from "./NameForm.js";
// DEC 254zzz84 (2): there is no "Leave company" here. People don't leave on their own; a company owner or admin removes them (with a hand-over).
export function AccountMenu({ nav }: { nav: ReadAppNav }) {
 const host = useAppHost(), theme = useTheme();
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function signOut() { setBusy(true);setError(undefined);try { await host.signOut();host.signIn("/app", { differentWorkspace: true }); } catch (error) { setError(error instanceof ApiError ? error.message : "Couldn't sign out. Try again."); } finally { setBusy(false); } }
 return <Dialog title="Your account" open={open} onOpenChange={setOpen} trigger={<Button aria-label="Open account menu" data-testid="account-menu" variant="quiet"><VisibleText text={nav.me.name} /></Button>}><p><VisibleText text={nav.org.name} /></p><NameForm key={nav.me.name} label="Your name" initial={isPlaceholderDisplayName(nav.me.name) ? "" : nav.me.name} submit="Save name" /><fieldset className="rv-theme-options"><legend>Appearance</legend>{(["system", "light", "dark"] as const).map((value: ThemePreference) => <label key={value}><input type="radio" name="appearance" value={value} checked={theme.preference === value} onChange={() => theme.setPreference(value)} />{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</label>)}</fieldset><p><Link to="/app/account" onClick={() => setOpen(false)}>Your account page</Link></p><div className="rv-account-actions"><Button onClick={() => { void signOut(); }} busy={busy}>Sign out</Button></div>{error && <p role="alert"><VisibleText text={error} /></p>}</Dialog>;
}
