import { useRef, useState } from "react";
import type { EvalWrapperCard as WrapperCard } from "@agentx/contracts/web";
import { useEvalCardApi } from "../../api/eval-card.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** What this card says itself. Every sentence about the file, a pull request or an edge case is Code's own (`line`, `copyOnly.text`); the page works nothing out. */
export const EVAL_WRAPPER_WORDS = {
  view: "View the file",
  addMyself: "I'll add it myself",
  openPullRequest: "Let Rovara open a pull request",
  notNow: "Not now",
  setUpNow: "Set up now",
  checkNow: "Check now",
  copy: "Copy",
  copied: "Copied",
  download: "Download",
  review: "Review the pull request",
  whereTo: (path: string) => `Add this file as ${path} on your default branch. Rovara looks for it there by itself, or you can check now.`,
  noOne: "A company owner, admin or this project's maintainer can have Rovara open a pull request or set this aside. You can view the file and copy it.",
  setAside: "Set aside for now. Pull requests will say the eval was not read until it is set up.",
  sendError: "Couldn't send that. Try again.",
  copyError: "Couldn't copy it. Select the file and copy it instead.",
} as const;

type Act = "open_pull_request" | "dismiss" | "reopen" | "check";
/** Steps where "Check now" stands on its own (the file may have landed on the default branch since); at "needs file" it sits in the "I'll add it myself" panel. */
const STANDALONE_CHECK: ReadonlyArray<WrapperCard["step"]> = ["pull_request_open", "file_outdated", "unreadable", "not_offered"];

/**
 * ONE card per eval whose results Rovara cannot read as they are (DEC 254zzz43): "Rovara can't read the results of <eval> yet", with [View the file] · [I'll add it myself] · [Let Rovara open a pull request] ·
 * [Not now]. Anyone who can see the project sees the file and copies it; only the people Code lets (`canManage`, and Code's own `canOpenPullRequest`) open the pull request or set it aside. The server decides each
 * act again, live. A press sends one request (the latch), whatever is pressed next.
 */
export function EvalWrapperCardView({ project, card, canManage, onChanged }: { project: string; card: WrapperCard; canManage: boolean; onChanged: () => void }) {
  const api = useEvalCardApi();
  const [panel, setPanel] = useState<"view" | "add">(), [busy, setBusy] = useState<string>(), [problem, setProblem] = useState<string>(), [note, setNote] = useState<string>();
  const sending = useRef(false);
  const act = async (action: Act) => {
    if (sending.current) return;
    sending.current = true; setBusy(action); setProblem(undefined); setNote(undefined);
    try {
      const answer = await api.wrapperAct(project, { requestId: crypto.randomUUID(), action, ...(action === "open_pull_request" ? { selection: card.selection } : {}) });
      // A pull request that could not be opened is said in Code's own words on the re-read card (the file is then offered to copy); this page does not word a failure.
      void answer;
      onChanged();
    } catch (caught) { setProblem(caught instanceof ApiError ? caught.message : EVAL_WRAPPER_WORDS.sendError); }
    finally { sending.current = false; setBusy(undefined); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(card.content); setNote(EVAL_WRAPPER_WORDS.copied); } catch { setProblem(EVAL_WRAPPER_WORDS.copyError); }
  };
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([card.content], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = card.path.split("/").pop() ?? "eval-wrapper"; link.rel = "noopener"; link.click();
      URL.revokeObjectURL(url);
    } catch { setProblem(EVAL_WRAPPER_WORDS.copyError); }
  };
  const showable = card.offered && card.content !== "";
  const may = (name: Act) => busy !== undefined && busy !== name;
  const stillOpen = card.step === "needs_file" || card.step === "not_offered";
  const link = card.pullRequest?.url !== undefined && card.pullRequest.url.startsWith("https://") ? card.pullRequest.url : undefined;

  // "Not now": a quiet row (the place the Evals page will list it); a person who may can bring it back.
  if (card.step === "dismissed") {
    return <div data-testid="eval-wrapper" data-step={card.step}>
      <p><VisibleText text={card.title} /></p>
      <p className="rv-muted" data-testid="eval-wrapper-dismissed">{EVAL_WRAPPER_WORDS.setAside}</p>
      {canManage && <div className="rv-connect-actions rv-approval-actions"><Button busy={busy === "reopen"} disabled={may("reopen")} data-testid="eval-wrapper-reopen" onClick={() => { void act("reopen"); }}>{EVAL_WRAPPER_WORDS.setUpNow}</Button></div>}
      {problem !== undefined && <p role="alert" data-testid="eval-wrapper-problem"><VisibleText text={problem} /></p>}
    </div>;
  }
  return <div data-testid="eval-wrapper" data-step={card.step}>
    <h5><VisibleText text={card.title} /></h5>
    <p data-testid="eval-wrapper-line"><VisibleText text={card.line} /></p>
    {link !== undefined && <p><a href={link} target="_blank" rel="noopener noreferrer" data-testid="eval-wrapper-link">{EVAL_WRAPPER_WORDS.review}</a></p>}
    {card.copyOnly !== undefined && <p className="rv-muted" data-testid="eval-wrapper-copy-only"><VisibleText text={card.copyOnly.text} /></p>}
    {note !== undefined && <p className="rv-muted" role="status" data-testid="eval-wrapper-note"><VisibleText text={note} /></p>}
    <div className="rv-connect-actions rv-approval-actions">
      {showable && <Button aria-expanded={panel === "view"} data-testid="eval-wrapper-view" disabled={busy !== undefined} onClick={() => { setPanel(panel === "view" ? undefined : "view"); }}>{EVAL_WRAPPER_WORDS.view}</Button>}
      {showable && <Button aria-expanded={panel === "add"} data-testid="eval-wrapper-add" disabled={busy !== undefined} onClick={() => { setPanel(panel === "add" ? undefined : "add"); }}>{EVAL_WRAPPER_WORDS.addMyself}</Button>}
      {card.canOpenPullRequest && <Button variant="primary" busy={busy === "open_pull_request"} disabled={may("open_pull_request")} data-testid="eval-wrapper-open" onClick={() => { void act("open_pull_request"); }}>{EVAL_WRAPPER_WORDS.openPullRequest}</Button>}
      {canManage && stillOpen && <Button busy={busy === "dismiss"} disabled={may("dismiss")} data-testid="eval-wrapper-dismiss" onClick={() => { void act("dismiss"); }}>{EVAL_WRAPPER_WORDS.notNow}</Button>}
      {STANDALONE_CHECK.includes(card.step) && <Button busy={busy === "check"} disabled={may("check")} data-testid="eval-wrapper-check" onClick={() => { void act("check"); }}>{EVAL_WRAPPER_WORDS.checkNow}</Button>}
    </div>
    {showable && panel !== undefined && <div data-testid={panel === "view" ? "eval-wrapper-view-panel" : "eval-wrapper-add-panel"}>
      {panel === "add" && <p><VisibleText text={EVAL_WRAPPER_WORDS.whereTo(card.path)} /></p>}
      <p className="rv-muted" data-testid="eval-wrapper-path"><VisibleText text={card.path} /></p>
      <pre data-testid="eval-wrapper-file" tabIndex={0} aria-label={card.path}><VisibleText text={card.content} /></pre>
      <div className="rv-connect-actions rv-approval-actions">
        <Button data-testid="eval-wrapper-copy" disabled={busy !== undefined} onClick={() => { void copy(); }}>{EVAL_WRAPPER_WORDS.copy}</Button>
        <Button data-testid="eval-wrapper-download" disabled={busy !== undefined} onClick={download}>{EVAL_WRAPPER_WORDS.download}</Button>
        {panel === "add" && <Button busy={busy === "check"} disabled={may("check")} data-testid="eval-wrapper-check" onClick={() => { void act("check"); }}>{EVAL_WRAPPER_WORDS.checkNow}</Button>}
      </div>
    </div>}
    {!canManage && stillOpen && <p className="rv-muted" data-testid="eval-wrapper-who">{EVAL_WRAPPER_WORDS.noOne}</p>}
    {problem !== undefined && <p role="alert" data-testid="eval-wrapper-problem"><VisibleText text={problem} /></p>}
  </div>;
}
