import { useState, type ReactNode } from "react";
import { PageHeader } from "../../design/PageHeader.js";
import { IdentityContext, IdentityFreshContext, PinContext, WroteContext, isFresh, servedFacts, useIdentityRead, type WriteKind } from "./read-model.js";
import { ReadState } from "./ReadState.js";
import { ReconnectingFrame } from "./reconnecting.js";

/** `title` names the page while its identity read is pending or failed, so the heading never disappears. */
export function ReadEntry({ children, title, code = "ACCOUNT-READ-FAILED" }: { children: ReactNode; title?: string; code?: string }) {
 const identity = useIdentityRead(), [pinned, setPinned] = useState<{ node: ReactNode; who: string }>(), [written, setWritten] = useState<{ kind: WriteKind; who: string }>(), [seen, setSeen] = useState<string>();
 // Who the frame is for right now. A pinned node belongs to the person and company it was pinned for: it is drawn only while that is still the answer (an access loss or another person ends it).
 const facts = servedFacts(identity).data, who = facts === undefined ? undefined : `${facts.org.orgId}:${facts.developer.id}`;
 // A remembered write belongs to the person and company that made it (F8): it is kept with their `who` and cleared the moment the frame shows another person or company
 // (it survives an access loss, where `who` is undefined: `seen` is the last one known, and that is exactly when the sentence is needed).
 if (who !== undefined && who !== seen) { setSeen(who); if (written !== undefined && written.who !== who) setWritten(undefined); }
 const current = who ?? seen, wrote = written !== undefined && written.who === current ? written.kind : undefined;
 const note = (kind: WriteKind) => { if (current !== undefined) setWritten({ kind, who: current }); };
 const pin = (node: ReactNode) => { setPinned(node === null || who === undefined ? undefined : { node, who }); };
 return <section className="g5-account-setup-read" aria-label="Account and setup read view"><PinContext.Provider value={pin}><WroteContext.Provider value={{ wrote, note }}><div className="g5-state">
  {title !== undefined && facts === undefined && <PageHeader title={title} />}
  <ReconnectingFrame><ReadState query={identity} label="your account" variant="page" code={code}>{me => <IdentityContext.Provider value={me} key={`${me.org.orgId}:${me.developer.id}`}><IdentityFreshContext.Provider value={isFresh(identity)}>{children}</IdentityFreshContext.Provider></IdentityContext.Provider>}</ReadState></ReconnectingFrame>
 </div>{pinned !== undefined && pinned.who === who ? pinned.node : null}</WroteContext.Provider></PinContext.Provider></section>;
}
