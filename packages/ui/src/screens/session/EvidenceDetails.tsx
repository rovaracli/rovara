import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { DECISION_FOCUS_PARAM } from "@agentx/cloud-contracts/web";
import { useDecisions } from "../../api/decisions.js";
import type { ReadSession } from "./SessionHeader.js";
import { useLead } from "./TaskLead.js";
import { mustActInside, type MustAct } from "./must-act.js";
import { cardElementId } from "./task-plain-state.js";
import { workspaceTask } from "./workspace-types.js";

/**
 * The work and its evidence behind a disclosure, for the phone order of the task page. Closed, unless the address names a tab (`#evidence`, `#plan`...), which a link from Slack does, or something
 * inside it needs this reader now (`mustAct`: Understand's questions, a Merge the reader may press). A later change of the address (an in-page link to a tab) opens it too.
 * Opening for an action scrolls the thing to act on into view and does not move focus, unless the reader came by a "needs you" link (the address carries the decision focus parameter).
 * The reader closing it by hand is respected: it stays closed until the address changes again or a new action (the next round of questions) appears.
 */
export function EvidenceDetails({ children, mustAct }: { children: ReactNode; mustAct?: MustAct | undefined }) {
 const hash = useLocation().hash, [params] = useSearchParams(), key = mustAct?.key;
 const [open, setOpen] = useState(hash.length > 1 || key !== undefined), [seen, setSeen] = useState(hash), [acted, setActed] = useState(key);
 if (hash !== seen) { setSeen(hash);if (hash.length > 1 && !open) setOpen(true); }
 // A new action opens it; the same action seen again (a re-read, a closed disclosure) does not. With no action the next one counts as new.
 if (key !== acted) { setActed(key);if (key !== undefined && !open) setOpen(true); }
 const scrolled = useRef<string | undefined>(undefined), root = useRef<HTMLDetailsElement>(null), cameByLink = params.has(DECISION_FOCUS_PARAM), focusParam = params.get(DECISION_FOCUS_PARAM);
 const targetId = mustAct?.targetId;
 useEffect(() => {
  if (key === undefined || targetId === undefined) { scrolled.current = undefined;return; }
  if (scrolled.current === key) return;
  // Bring the thing to act on into view, and put focus on it only for a reader who followed a "needs you" link (never over a decision card that link names: the card takes focus itself).
  // One tick later: when the page first draws it puts focus on its heading, after this effect, and that scrolls back to the top. A reader who has already moved focus elsewhere is left alone.
  const reveal = (target: HTMLElement) => {
   scrolled.current = key;
   setTimeout(() => {
    if (!target.isConnected) return;
    target.scrollIntoView?.({ block: "start" });
    const now = document.activeElement;
    if (cameByLink && (focusParam === null || document.getElementById(cardElementId(focusParam)) === null) && (now === null || now === document.body || now.tagName === "H1")) { target.setAttribute("tabindex", "-1");target.focus(); }
   }, 0);
  };
  const found = document.getElementById(targetId);
  if (found !== null) { reveal(found);return; }
  // The work is drawn a moment after the disclosure (a part of it loads on its own): wait for the target, for a few seconds at most.
  const watched = root.current;
  if (watched === null) return;
  const stop = () => { observer.disconnect();clearTimeout(timer); };
  const observer = new MutationObserver(() => { const late = document.getElementById(targetId);if (late !== null) { stop();reveal(late); } }), timer = setTimeout(stop, 5000);
  observer.observe(watched, { childList: true, subtree: true });
  return stop;
 }, [key, targetId, cameByLink, focusParam]);
 return <details ref={root} className="rv-session-evidence" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>Work details and evidence</summary>{children}</details>;
}

/** The phone order's disclosure, opened by itself when the page's lead block sends the reader to something inside it (see `mustActInside`). */
export function PhoneWorkDetails({ session, children }: { session: ReadSession; children: ReactNode }) {
 const lead = useLead(session), decisions = useDecisions();
 return <EvidenceDetails mustAct={mustActInside({ session, task: workspaceTask(session), lead, decisionsKnown: !decisions.isPending })}>{children}</EvidenceDetails>;
}
