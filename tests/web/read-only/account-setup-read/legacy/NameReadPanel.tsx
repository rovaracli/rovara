// TEST-ONLY legacy harness: the display-only name card of the G5 rebuild. Production shows the live name prompt (shell/NamePrompt.tsx) and the Account name row (NameReadRow).
import { isPlaceholderDisplayName } from "@agentx/contracts/web";
import { VisibleText } from "../../../../../packages/ui/src/design/VisibleText.js";
import { Fact, Facts } from "../../../../../packages/ui/src/screens/account-setup-read/parts.js";
import { useReadIdentity } from "../../../../../packages/ui/src/screens/account-setup-read/read-model.js";

/** The quiet name section a first page carried: one fact, never a screen in front of the destination. */
export function NameReadPanel() {
 const { developer } = useReadIdentity();
 const name = developer.name, unnamed = isPlaceholderDisplayName(name), supplied = !unnamed && developer.nameChosen === false;
 return <section className="g5-card g5-name" aria-label="Your name">
  <h2>{unnamed ? "Choose your name" : "Your name"}</h2>
  {unnamed ? <p className="g5-lede">You haven&apos;t chosen a name yet. You can choose one in Account.</p> : supplied ? <p className="g5-lede">This is the name your sign-in supplied. You haven&apos;t chosen a name yet. You can choose one in Account.</p> : null}
  <Facts><Fact label="Your name">{unnamed ? "Not chosen yet" : <VisibleText text={name} />}</Fact></Facts>
  <p className="g5-note">Shown on tasks you start, on your decisions and comments, and in Company, People. It is not your sign-in{unnamed || supplied ? " and can be changed in Account" : ""}.</p>
 </section>;
}
