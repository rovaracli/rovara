// exp/automations: what a person is told after pressing a button here: done, waiting for an admin (a 202, with the confirmation link), or refused (the server's sentence, word for word).
import { createContext, useContext } from "react";
import { useAppHost } from "../../host.js";
import type { SendResult } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isConfirmUrl } from "../../text/links.js";
import { NOT_ALLOWED, NOT_ALLOWED_TO_SEE, problemOf, waitingWords, type Problem } from "./automation-text.js";

/** Whether the chain on this page is shared with the whole company (only then is "an admin" the one who confirms). Unknown, or no chain, is `undefined`. */
export const CompanySharedContext = createContext<boolean | undefined>(undefined);

export type Note =
  | { kind: "done"; text: string; detail?: string[] }
  | { kind: "waiting"; confirmUrl?: string; changes: string[] }
  | { kind: "approval"; message: string }
  | { kind: "problem"; problem: Problem };

/** Turns what a write answered into the note to show; `done` is the sentence for a write that went through. */
export function noteOf<T>(result: SendResult<T>, done: string, detail?: string[]): Note {
  if (result.kind === "done") return { kind: "done", text: done, ...(detail === undefined || detail.length === 0 ? {} : { detail }) };
  if (result.kind === "needs_confirmation") return { kind: "waiting", changes: result.changes, ...(result.confirmUrl === undefined ? {} : { confirmUrl: result.confirmUrl }) };
  return { kind: "approval", message: result.message };
}
/** A refusal as a note. A read (`read: true`) that is refused says "You can't see this." rather than "change". */
export const problemNote = (error: unknown, read = false): Note => ({ kind: "problem", problem: problemOf(error, undefined, read) });

export function ActionNote({ note }: { note: Note | undefined }) {
  const host = useAppHost(), shared = useContext(CompanySharedContext);
  if (note === undefined) return null;
  if (note.kind === "done") return <div role="status" className="rv-auto-note"><p><VisibleText text={note.text} /></p>{note.detail !== undefined && <ul>{note.detail.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul>}</div>;
  if (note.kind === "waiting") {
    const url = note.confirmUrl;
    return <div role="status" className="rv-auto-note"><p><strong>{waitingWords(shared)}</strong></p>{note.changes.length > 0 && <ul>{note.changes.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul>}{url !== undefined && isConfirmUrl(url, host.origin) && <p><Button onClick={() => { host.openExternal(url); }}>Open the confirmation page</Button></p>}</div>;
  }
  if (note.kind === "approval") return <div role="status" className="rv-auto-note"><p><strong>Waiting for an admin to approve</strong></p><p><VisibleText text={note.message} /></p></div>;
  const { problem } = note;
  return <div role="alert" className="rv-auto-note rv-auto-problem">{problem.forbidden && <p><strong>{problem.read === true ? NOT_ALLOWED_TO_SEE : NOT_ALLOWED}</strong></p>}<p><VisibleText text={problem.message} /></p>{problem.reauth && <p><Button onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></p>}</div>;
}
