import type { ReactNode } from "react";
import { isPlaceholderDisplayName } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { RowBody } from "./parts.js";
import { useReadIdentity } from "./read-model.js";

function useNameFacts() {
 const { developer } = useReadIdentity();
 const unnamed = isPlaceholderDisplayName(developer.name);
 const supplied = !unnamed && developer.nameChosen === false;
 return { name: developer.name, unnamed, supplied };
}
/** The name row inside Account's "You" group. `action` is the row's one control (Change name opens the live name form). */
export function NameReadRow({ action }: { action?: ReactNode }) {
 const { name, unnamed, supplied } = useNameFacts(), { developer: { email } } = useReadIdentity();
 return <li className="g5-row" aria-label="Your name"><RowBody lead={<span className="g5-avatar" aria-hidden="true">{unnamed ? (email === undefined ? "?" : Array.from(email)[0]?.toUpperCase()) : Array.from(name)[0]?.toUpperCase()}</span>}
  title={unnamed ? "Not chosen yet" : <VisibleText text={name} />} detail={unnamed ? "You haven't chosen a name yet." : supplied ? "This is the name your sign-in supplied. You haven't chosen a name yet." : "The name teammates see"} />{action !== undefined && <div className="g5-row-aside">{action}</div>}</li>;
}
