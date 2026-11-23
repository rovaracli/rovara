import { useState } from "react";
import { isPlaceholderDisplayName, type ReadAppNav } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { Button } from "../design/Button.js";
import { VisibleText } from "../design/VisibleText.js";
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
 // Board name-prompt / mock 25a: one quiet card, a section of the page (never a screen in front of the link), with the one field. The words say only what is
 // true here: teammates see the name in the header until one is chosen (never the email), Not now keeps the page as it is.
 const placeholder = isPlaceholderDisplayName(me.name);
 return <aside className="rv-name-prompt" aria-label="Your name">
  <h2>Choose your name</h2>
  <p className="rv-name-prompt-lede">Pick the name your teammates will see. Until you choose, they see <b><VisibleText text={me.name} /></b>{placeholder ? "" : ", the name your sign-in supplied"}.</p>
  <NameForm label="Your name" initial={placeholder ? "" : me.name} submit="Save name" onSaved={() => setDismissed(true)} secondary={<Button variant="quiet" onClick={dismiss}>Not now</Button>} />
  <p className="rv-name-prompt-note">Shown on tasks you start, on your decisions and comments, and in Company, People. It is not your sign-in and can be changed in Account. Not now keeps this page as it is; Account asks again.</p>
 </aside>;
}
