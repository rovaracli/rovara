import { useState, type ReactNode } from "react";
import type { SessionAnchorRef } from "@agentx/contracts/web";
import { TaskErrorBlock } from "./TaskErrorBlock.js";

type TalkTimelineReadRecoveryViewProps = {
 errorKind?: "initial" | "refresh" | "refused";
 anchor?: SessionAnchorRef;
 cachedMessages?: ReactNode;
 onReload: (anchor: SessionAnchorRef | undefined) => Promise<void>;
};

/** F737 recovery for the conversation read; the parent keeps the composer and its draft mounted. */
export function TalkTimelineReadRecoveryView({ errorKind = "initial", anchor, cachedMessages, onReload }: TalkTimelineReadRecoveryViewProps) {
 const [reloading, setReloading] = useState(false);
 async function reload() {
  if (reloading) return;
  setReloading(true);
  try { await onReload(anchor); }
  catch { /* The failed read remains visible until the parent receives a successful read. */ }
  finally { setReloading(false); }
 }
 const refused = errorKind === "refused";
 return <section aria-label="Conversation read recovery" data-testid="talk-timeline-read-recovery">
  <TaskErrorBlock
   title={refused ? "You no longer have access to this conversation" : "The conversation could not be loaded"}
   happened={refused ? "Rovara can't show this conversation to you any more. Nothing that was on it is kept here." : "The conversation could not be loaded. Your unsent text remains while this page stays open. Reload the conversation."}
   safe="Nothing was sent or changed."
   next="Reload it. What you are writing stays in the box."
   action={{ label: reloading ? "Reloading the conversation" : "Reload the conversation", onClick: () => { void reload(); } }}
   refCode={refused ? "TALK-ACCESS-LOST" : "TALK-READ-FAILED"} />
  {errorKind === "refresh" && cachedMessages}
 </section>;
}
