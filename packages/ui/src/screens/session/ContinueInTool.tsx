import { useEffect, useId, useRef, useState } from "react";
import { useLocalTools } from "../../api/lessons-local-tools.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
import { VisuallyHidden } from "../../design/VisuallyHidden.js";
import { CLI_PACKAGE, TOOLS, installCommand, lessonsLine, loadPrompt, NO_BRANCH_PUBLISH, NO_BRANCH_YET, pushExplainer, uniqueBranch, LOAD_TOOLS, type ContinueOffer, type LoopBranch, type ToolKind } from "./continue-in-tool.js";
import { OutsideChanges, PublishBranch } from "./ContinueLoopParts.js";
import "./continue-in-tool.css";

const COPIED_MS = 2500;
/** A copy button: the host's clipboard where it has one, the browser's otherwise. "Copied" shows on the button and is announced; a failure says so and the text stays selectable above. */
function CopyButton({ text, label, what }: { text: string; label: string; what: string }) {
 const host = useAppHost(), [last, setLast] = useState<{ text: string; kind: "copied" | "failed" }>(), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 // What was last tried counts only for the text it was tried on: choosing another tool changes the command, and its button starts fresh.
 const state = last?.text === text ? last.kind : "idle";
 useEffect(() => () => { clearTimeout(timer.current); }, []);
 async function copy() {
  try {
   if (host.copyText !== undefined) await host.copyText(text);
   else if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) await navigator.clipboard.writeText(text);
   else throw new Error("unavailable");
   setLast({ text, kind: "copied" });clearTimeout(timer.current);timer.current = setTimeout(() => setLast(undefined), COPIED_MS);
  } catch { clearTimeout(timer.current);setLast({ text, kind: "failed" }); }
 }
 return <span className="rv-continue-copy"><Button variant="secondary" className="rv-continue-copy-button" onClick={() => { void copy(); }}>{state === "copied" ? "Copied" : label}</Button>
  <span role="status" aria-live="polite">{state === "copied" && <VisuallyHidden>{"Copied the " + what}</VisuallyHidden>}{state === "failed" && <span className="rv-muted">Couldn't copy. Select the text above and copy it yourself.</span>}</span></span>;
}

/** What the lessons switch says for this project. Shown only where the answer says; any failure (no such setting here, no permission to read it) leaves it out. */
function Lessons({ project }: { project: string }) {
 const read = useLocalTools(project);
 const line = read.isError ? undefined : lessonsLine(read.data);
 return line === undefined ? null : <section aria-label="Lessons in your tool"><h3>Lessons</h3><p>{line}</p></section>;
}

type PullRequests = ContinueOffer["pullRequests"];
function PullRequestLinks({ pullRequests }: { pullRequests: PullRequests }) {
 return <>{pullRequests.map((pr, index) => <span key={pr.url}>{index > 0 && ", "}{/^https:\/\//u.test(pr.url) ? <a href={pr.url} target="_blank" rel="noopener noreferrer"><VisibleText text={pr.repository + " #" + String(pr.number)} /></a> : <VisibleText text={pr.repository + " #" + String(pr.number)} />}</span>)}</>;
}

/** The branch row. A server without the continue loop (no `continueLoop` in the task view) reads as it always did. With it, each repository shows its branch, or Publish working branch where the reader may make one. */
function BranchFact({ offer, branches, onPublished }: { offer: ContinueOffer; branches: readonly LoopBranch[]; onPublished: (branch: LoopBranch) => void }) {
 const loop = offer.loop;
 if (loop === undefined) return offer.branch !== undefined ? <code><VisibleText text={offer.branch} /></code> : offer.pullRequests.length === 0 ? <>{NO_BRANCH_YET}</> : <>Rovara opened {offer.pullRequests.length === 1 ? "a pull request" : "pull requests"}: <PullRequestLinks pullRequests={offer.pullRequests} />. Its page names the branch.</>;
 const repositories = [...new Set([...offer.repositories, ...branches.map(entry => entry.repository)])];
 if (repositories.length === 0) return branches.length === 0 && offer.branch === undefined ? <>{NO_BRANCH_YET}</> : <code><VisibleText text={offer.branch ?? ""} /></code>;
 const many = repositories.length > 1;
 return <ul className="rv-continue-branches">{repositories.map(repository => {
  const entry = branches.find(item => item.repository === repository), requests = offer.pullRequests.filter(pr => pr.repository === repository);
  return <li key={repository}>{many && <><VisibleText text={repository} />{": "}</>}
   {entry !== undefined ? <><code><VisibleText text={entry.branch} /></code>{" "}{entry.source === "published" ? "(made by Rovara, no pull request yet)" : <>(pull request <PullRequestLinks pullRequests={requests.length > 0 ? requests : entry.pullRequest === undefined ? [] : [{ repository, number: entry.pullRequest.number, url: entry.pullRequest.url }]} />)</>}</>
    : loop.canPublishBranch ? <><span className="rv-continue-note">{NO_BRANCH_PUBLISH}</span> <PublishBranch offer={offer} repository={repository} labelled={many} onPublished={onPublished} /></>
    : requests.length > 0 ? <>Rovara opened <PullRequestLinks pullRequests={requests} />. Its page names the branch.</> : NO_BRANCH_YET}</li>;
 })}</ul>;
}

function Panel({ offer }: { offer: ContinueOffer }) {
 const [tool, setTool] = useState<ToolKind>("claude-code"), groupId = useId(), current = TOOLS.find(entry => entry.kind === tool)!;
 // A branch just published shows (and goes into the prompt) at once; the task view read again carries it from then on.
 const [published, setPublished] = useState<readonly LoopBranch[]>([]);
 const branches = [...(offer.loop?.branches ?? []), ...published.filter(entry => !(offer.loop?.branches ?? []).some(known => known.repository === entry.repository))];
 const branch = offer.loop === undefined ? offer.branch : uniqueBranch(branches) ?? offer.branch;
 const command = installCommand(tool), prompt = loadPrompt({ taskId: offer.taskId, branch, branches });
 return <div className="rv-continue-body">
  <section aria-label="Your tool"><fieldset className="rv-continue-tools"><legend>1. Choose your tool</legend>
   {TOOLS.map(entry => <label key={entry.kind} className="rv-option" htmlFor={groupId + entry.kind}><input id={groupId + entry.kind} type="radio" name={groupId} checked={tool === entry.kind} onChange={() => setTool(entry.kind)} /> {entry.label}</label>)}
  </fieldset></section>
  <section aria-label={"Install for " + current.label}><h3>{"2. Install Rovara in " + current.label}</h3>
   <p className="rv-muted">Once per computer. Sign in first with <code>{"npx " + CLI_PACKAGE + " login <your Rovara address>"}</code> if you haven't.</p>
   <pre className="rv-continue-code" tabIndex={0} aria-label={"Install command for " + current.label}><code>{command}</code></pre>
   <CopyButton text={command} label="Copy install command" what="install command" />
   <p className="rv-muted">{current.where} If your admin gave you an environment name, add <code>--env &lt;name&gt;</code> before <code>mcp</code>.</p>
  </section>
  <section aria-label="Load the task"><h3>3. Ask your tool to load the task</h3>
   <dl className="rv-continue-facts">
    <div><dt>Task</dt><dd><VisibleText text={offer.title} /></dd></div>
    <div><dt>Task id</dt><dd><code>{offer.taskId}</code></dd></div>
    <div><dt>Branch</dt><dd><BranchFact offer={offer} branches={branches} onPublished={entry => setPublished(old => [...old, entry])} /></dd></div>
    <div><dt>Tool to call</dt><dd>{LOAD_TOOLS.map((name, index) => <span key={name}>{index > 0 && " then "}<code>{name}</code></span>)}</dd></div>
   </dl>
   <pre className="rv-continue-code rv-continue-prompt" tabIndex={0} aria-label="Prompt to paste into your tool"><code>{prompt}</code></pre>
   <CopyButton text={prompt} label="Copy prompt" what="prompt" />
  </section>
  <section aria-label="When you push"><h3>When you push</h3><p>{pushExplainer(offer.loop)}</p><OutsideChanges offer={offer} loop={offer.loop} /></section>
  {offer.project !== undefined && <Lessons project={offer.project} />}
 </div>;
}

/**
 * "Continue in your own tool" (switch `rovara.continue`, continue-flags.ts): a button on the task page that opens a sheet with the install command for Claude Code, Codex or Cursor, the prompt that loads this
 * task, the branch (when the task view has one) and what happens when the person pushes. This whole module is a lazy chunk. The sheet is a modal dialog: focus stays inside it, Escape closes it and focus returns to the button.
 */
export default function ContinueInTool({ offer }: { offer: ContinueOffer }) {
 return <Dialog title="Continue in your own tool" description="Pick this task up in Claude Code, Codex or Cursor." className="rv-continue" trigger={<Button>Continue in your own tool</Button>}><Panel offer={offer} /></Dialog>;
}
