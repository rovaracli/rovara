import { useState, type ReactNode } from "react";
import { Button } from "../../design/Button.js";
import { HeldState } from "../../design/HeldState.js";
import { VisibleText } from "../../design/VisibleText.js";
import { clockTime } from "./task-time.js";
import "./task-page.css";

export type TalkKind = "steer" | "comment" | "question";
const KIND_WORDS: Record<TalkKind, string> = { steer: "Instruction", comment: "Comment", question: "Question" };
const KIND_ICON: Record<TalkKind, ReactNode> = {
 steer: <path d="M8 13V3m0 0L4 7m4-4 4 4" />,
 comment: <path d="M2 3h12v8H6l-4 3V3Z" />,
 question: <><circle cx="8" cy="8" r="6" /><path d="M6 6.2a2 2 0 1 1 3 1.7C8.3 8.3 8 8.6 8 9.4M8 11.4v.1" /></>,
};

/** The initial of a person in a round mark, as in the Talk mocks. Decorative: the name is next to it. */
export function TalkAvatar({ name }: { name: string }) {
 return <span className="rv-message-avatar" aria-hidden="true">{[...name.trim()][0]?.toUpperCase() ?? "?"}</span>;
}

/** The kind chip at the right of a message card's header row (Instruction, Comment, Question). */
export function TalkKindChip({ kind }: { kind: TalkKind }) {
 return <span className="rv-message-kind-chip" data-kind={kind}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{KIND_ICON[kind]}</svg>{KIND_WORDS[kind]}</span>;
}

/** One message card: avatar, name and time, the kind chip at the right, then what the message says and its receipt. */
export function TalkCard({ name, at, source, kind, tone, label, children, testId }: { name: string; at: string | undefined; source?: string | undefined; kind: TalkKind; tone?: "bad" | undefined; label?: string; children: ReactNode; testId?: string }) {
 const time = clockTime(at);
 return <div className="rv-message-card rv-talk-card" data-tone={tone} aria-label={label} data-testid={testId}>
  <div className="rv-message-top"><TalkAvatar name={name} /><div className="rv-message-meta"><strong><VisibleText text={name} /></strong>{time !== undefined && <time dateTime={at}>{time}</time>}{source !== undefined && source !== "" && <span>· {source}</span>}</div><TalkKindChip kind={kind} /></div>
  {children}
 </div>;
}

export interface LadderStep { state: "ok" | "bad" | "running" | "pending"; label: string; at?: string | undefined; detail?: string | undefined; unknown?: boolean | undefined }
/** The receipt ladder under an instruction: every step Rovara recorded, in order. A step the server does not report is one Unknown chip. */
export function TalkLadder({ steps }: { steps: readonly LadderStep[] }) {
 return <ul className="rv-message-delivery rv-receipt-ladder" role="status">
  {steps.map(step => <li key={step.label} data-tone={step.state}><span className="rv-receipt-dot" aria-hidden="true" /><span><strong>{step.label}</strong>{step.at !== undefined && clockTime(step.at) !== undefined && <> <time dateTime={step.at}>{clockTime(step.at)}</time></>}{step.detail !== undefined && step.detail !== "" && <span className="rv-receipt-detail"><VisibleText text={step.detail} /></span>}{step.unknown === true && <> <HeldState /></>}</span></li>)}
 </ul>;
}

/** The ladder an instruction's own delivery record supports. Delivered says nothing about Applied: that step shows as Unknown. */
export function deliveryLadder(delivery: { state: string; at?: string | undefined; reason?: string | undefined }): LadderStep[] {
 switch (delivery.state) {
  case "queued": return [{ state: "running", label: "Queued for this build", at: delivery.at, detail: "Rovara has it" }, { state: "pending", label: "Delivered", detail: "when the build acknowledges it" }, { state: "pending", label: "Applied", unknown: true }];
  case "delivered": return [{ state: "ok", label: "Queued for this build", detail: "Rovara has it" }, { state: "ok", label: "Delivered", at: delivery.at, detail: "the build acknowledged it" }, { state: "pending", label: "Applied", unknown: true }];
  case "not_delivered": return [{ state: "ok", label: "Queued for this build", detail: "Rovara has it" }, { state: "bad", label: "Not delivered", at: delivery.at }];
  default: return [{ state: "running", label: "Checking delivery", detail: "no reply from Rovara yet" }, { state: "pending", label: "Queued for this build", detail: "not confirmed" }];
 }
}

/** The mock's closing line of an ended thread: a fixed reference with Copy, where the composer was. */
export function TalkRefFooter({ refCode }: { refCode: string }) {
 const [copied, setCopied] = useState<string>();
 async function copy() { try { await navigator.clipboard.writeText(refCode);setCopied("Copied"); } catch { setCopied("Couldn't copy the reference."); } }
 return <div className="rv-talk-ref-footer" data-testid="talk-ref-footer"><code>Ref <VisibleText text={refCode} /></code><span aria-hidden="true">·</span><Button variant="quiet" aria-label="Copy reference" onClick={() => { void copy(); }}>Copy</Button>{copied !== undefined && <span role="status">{copied}</span>}</div>;
}
