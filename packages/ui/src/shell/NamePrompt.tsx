import { useState } from "react";
import { isPlaceholderDisplayName, type ReadAppNav } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { Button } from "../design/Button.js";
import { NameForm } from "./NameForm.js";
export const NAME_PROMPT_KEY = "rovara.name-prompt";
/**
 * Asks once, until it is answered or dismissed, what teammates should call a person whose name is not chosen yet (the sign-in's name, or a placeholder when it had
 * none). Dismissing is remembered on this device for this person; the account menu keeps the form for later. Nothing here shows the person's email.
 */
export function NamePrompt({ me }: { me: ReadAppNav["me"] }) {
 const host = useAppHost();
 const remembered = (() => { try { return host.storage.get(NAME_PROMPT_KEY) === me.developerId; } catch { return false; } })();
 const [dismissed, setDismissed] = useState(remembered);
 if (me.nameChosen !== false || dismissed) return null;
 const dismiss = () => { try { host.storage.set(NAME_PROMPT_KEY, me.developerId); } catch { /* the prompt may show again on the next visit */ }setDismissed(true); };
 return <aside className="rv-trial-banner rv-name-prompt" aria-label="Your name"><NameForm label="What should teammates call you?" initial={isPlaceholderDisplayName(me.name) ? "" : me.name} submit="Save name" onSaved={() => setDismissed(true)} secondary={<Button variant="quiet" onClick={dismiss}>Not now</Button>} /></aside>;
}
