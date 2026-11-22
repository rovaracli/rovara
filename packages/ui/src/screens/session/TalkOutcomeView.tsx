import type { ReactNode } from "react";
import { Banner } from "../../design/Banner.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import { TalkCard, TalkLadder, deliveryLadder, type TalkKind } from "./TalkParts.js";

type SessionAnchor = { href: string; label: string };
type ConfirmedOutcome =
 | { kind: "queued"; serverMessage: string }
 | { kind: "applied"; serverMessage: string; change?: string }
 | { kind: "refused"; serverMessage: string; reason: string };
type UnknownOutcome = { kind: "unknown" };
/** The message a lost send was carrying, so the task page can show the receipt inside that message's own card. */
export type TalkUnconfirmedMessage = { name: string; kind: Exclude<TalkKind, "question">; text: string; at: string };
type TalkOutcomeViewProps = { anchor: SessionAnchor; message?: TalkUnconfirmedMessage | undefined } & (
 | { outcome: UnknownOutcome; onCheck: () => void }
 | { outcome: ConfirmedOutcome; onCheck?: never }
);

function outcomeCopy(outcome: ConfirmedOutcome): { title: string; details: ReactNode } {
 switch (outcome.kind) {
  case "queued": return { title: "Queued for this build", details: <VisibleText text={outcome.serverMessage} /> };
  case "applied": return { title: "Applied", details: <><VisibleText text={outcome.serverMessage} />{outcome.change !== undefined && <p><VisibleText text={outcome.change} /></p>}</> };
  case "refused": return { title: "Not delivered", details: <><VisibleText text={outcome.serverMessage} /><p><VisibleText text={outcome.reason} /></p></> };
 }
}

/** The message status only; the session owner supplies this view's exact return anchor and read-only Check. */
export function TalkOutcomeView({ anchor, outcome, onCheck, message }: TalkOutcomeViewProps) {
 const page = useTaskPagePolicy() !== undefined;
 if (page && outcome.kind === "unknown" && message !== undefined) {
  return <section className="rv-answered rv-talk-unconfirmed-card" aria-label="Talk delivery outcome" data-talk-outcome="unknown">
   <TalkCard name={message.name} at={message.at} kind={message.kind}>
    <p className="rv-message-text"><VisibleText text={message.text} /></p>
    <TalkLadder steps={deliveryLadder({ state: "unknown" })} />
    <div className="rv-talk-refusal"><p><strong>Rovara didn&apos;t confirm this yet.</strong> <span className="rv-muted">The send may still be processing. Your text is kept.</span></p><Button onClick={onCheck}>Check delivery</Button></div>
   </TalkCard>
  </section>;
 }
 const confirmed = outcome.kind === "unknown" ? undefined : outcomeCopy(outcome);
 return <section className="rv-answered" aria-label="Talk delivery outcome" data-talk-outcome={outcome.kind}>
  <nav className="rv-task-back" aria-label="Back"><a href={anchor.href}>Back to <VisibleText text={anchor.label} /></a></nav>
  {confirmed !== undefined
   ? <Banner title={confirmed.title} tone={outcome.kind === "applied" ? "success" : outcome.kind === "refused" ? "warning" : "info"}>{confirmed.details}</Banner>
   : <Banner title="Rovara didn't confirm this yet." tone="warning">
    <p>The send may still be processing. Check delivery before sending another message.</p>
    <div className="rv-actions"><Button onClick={onCheck}>Check delivery</Button></div>
   </Banner>}
 </section>;
}
